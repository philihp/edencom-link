// Builds the industry-planning spreadsheet's static CSVs from the nightly SDE
// mirror — a JS port of the inherited full_sheet_gen.py (kept for reference at
// docs/sheet-csv/reference/full_sheet_gen.py). Shaped exactly like
// src/buildEsfData.js: reads its inputs from the sde_* mirror tables through
// the public-read anon key, transforms them in memory, and returns
// { [fileName]: csvString } without touching disk. The sheet-csv job
// (src/jobs/sheetCsv.js) upserts the result into the sheet_csv table and the
// /sheets/[file] route serves it for Google Sheets =IMPORTDATA().
//
// The transform itself (buildSheets) is a pure function over plain arrays so it
// can be unit-tested without a database; only encodeSheetCsv() reaches the DB.
//
// Full spec (field-by-field, plus the Python quirks deliberately NOT ported):
// docs/sheet-csv/01-port-generator.md.

// Same env + client as buildEsfData.js — the public-read sde_* mirror.
// @supabase/supabase-js is imported lazily in encodeSheetCsv() so this module's
// pure transform (buildSheets) loads with no runtime dependency and stays unit-
// testable without a database.
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_KEY

// PostgREST caps a response at 1000 rows, so page the mirror tables.
const PAGE_SIZE = 1000

// The seven files served at /sheets/[file], one source of truth shared by the
// encoder, the job's skip check, and the route allowlist. StaticInputs and
// StaticOutputs are the primary tabs; invention/types are secondary (same pass).
// The twines/miros pair differ only in group labeling (see groupLabel).
export const SHEET_FILE_NAMES = [
  'static-inputs-twines.csv',
  'static-inputs-miros.csv',
  'static-outputs-twines.csv',
  'static-outputs-miros.csv',
  'invention.csv',
  'types-twines.csv',
  'types-miros.csv',
]

// Hand-maintained constants carried over from the Python.
// Decryptors are force-included in types.csv even though nothing builds them.
const DECRYPTOR_NAMES = [
  'Accelerant Decryptor',
  'Attainment Decryptor',
  'Augmentation Decryptor',
  'Parity Decryptor',
  'Process Decryptor',
  'Symmetry Decryptor',
  'Optimized Attainment Decryptor',
  'Optimized Augmentation Decryptor',
]
// The SDE gives this blueprint no volume; the sheet wants a nominal one.
const OUTRIDER_BLUEPRINT_NAME = 'Outrider Blueprint'
const OUTRIDER_BLUEPRINT_VOLUME = '0.01'
// miros mode only: capital / structure / subsystem component groups label as
// "Component" instead of by tech level.
const COMPONENT_GROUP_IDS = new Set([334, 873, 913])

const MANUFACTURING = 'manufacturing'
const REACTION = 'reaction'
const INVENTION = 'invention'

// ── CSV serialization (RFC 4180, headered) ─────────────────────────────────
// Inlined rather than importing src/utils/csv.ts because these job modules run
// under plain `node`, which can't import TypeScript. Behavior matches toCsv():
// header from the first row's keys, CRLF line endings, minimal quoting.
const escapeField = (value) => {
  const s = value === null || value === undefined ? '' : String(value)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const toCsv = (rows) => {
  if (rows.length === 0) return ''
  const headers = Object.keys(rows[0])
  const lines = [headers, ...rows.map((row) => headers.map((h) => row[h]))]
  return lines.map((line) => line.map(escapeField).join(',')).join('\r\n')
}

// ── transform ──────────────────────────────────────────────────────────────

// A blueprint's output type id: first manufacturing product, else first
// reaction product, else null (a blueprint with only invention, or none).
// Mirrors the Python's get_output (manufacturing requires a products array;
// the reaction branch assumes one, matching the source).
const blueprintOutput = (bp) => {
  const activities = bp.activities ?? {}
  if (activities[MANUFACTURING]?.products) return activities[MANUFACTURING].products[0]?.typeID ?? null
  if (activities[REACTION]) return activities[REACTION].products?.[0]?.typeID ?? null
  return null
}

// When several blueprints produce the same output, keep only the one with the
// largest blueprint type id (assumed newest). Returns the surviving blueprints
// in the Python's dict-iteration order: no-output blueprints first (ascending
// id), then output blueprints in order of each output's first appearance during
// the ascending-id scan. A JS Map matches Python dict semantics — re-setting an
// existing key updates the value but keeps its original position.
const dedupeBlueprints = (blueprints) => {
  const sorted = [...blueprints].sort((a, b) => a._key - b._key)
  const noOutput = []
  const byOutput = new Map()
  for (const bp of sorted) {
    const output = blueprintOutput(bp)
    if (output === null) noOutput.push(bp)
    else byOutput.set(output, bp)
  }
  return [...noOutput, ...byOutput.values()]
}

/**
 * Pure transform: SDE type + blueprint rows → { [fileName]: csvString }.
 * @param {{ types: any[], blueprints: any[] }} input raw sde_* `data` objects
 *   (each carrying `_key`), exactly as the mirror stores them.
 */
export const buildSheets = ({ types, blueprints }) => {
  // Name maps (only types with an English name) + a full id→type table for
  // volume/group lookups in types.csv.
  const idToName = new Map()
  const nameToId = new Map()
  const typeData = new Map()
  for (const t of types) {
    typeData.set(t._key, t)
    const name = t.name?.en
    if (name != null) {
      idToName.set(t._key, name)
      nameToId.set(name, t._key)
    }
  }
  const nameOf = (id) => idToName.get(id) ?? `Type ${id}`

  const survivors = dedupeBlueprints(blueprints)

  // Pass 1: collect industry/invention rows and the id-membership sets. Group
  // labels can't be resolved yet — a type's label depends on whether anything
  // reacts/manufactures it, which isn't known until every blueprint is scanned.
  const seenTypes = new Set()
  const reactionTypes = new Set()
  const industryTypes = new Set()
  const inputRows = [] // { outputId, materialName, inputQty }
  const outputRows = [] // { outputId, outputQty, jobTime }
  const inventionRows = [] // fully resolved (no group), see below

  // One manufacturing/reaction activity → its input + output rows. Only single-
  // product activities with a materials list, matching the Python.
  const collectIndustry = (activity, outputSet) => {
    if (!activity || !Array.isArray(activity.products) || activity.products.length !== 1) return
    if (!Array.isArray(activity.materials)) return
    const product = activity.products[0]
    const outputId = product.typeID
    seenTypes.add(outputId)
    outputSet.add(outputId)
    for (const material of activity.materials) {
      seenTypes.add(material.typeID)
      inputRows.push({ outputId, materialName: nameOf(material.typeID), inputQty: material.quantity })
    }
    outputRows.push({ outputId, outputQty: product.quantity, jobTime: activity.time })
  }

  // Invention activity → one row per outcome. Only the two-datacore shape, as
  // in the Python (which then indexes datacore/blueprint names directly; the
  // port uses the Type <id> fallback rather than throwing on a missing name).
  const collectInvention = (activity, blueprintId) => {
    const materials = activity?.materials ?? []
    if (materials.length !== 2) return
    const [d1, d2] = materials
    seenTypes.add(d1.typeID)
    seenTypes.add(d2.typeID)
    seenTypes.add(blueprintId)
    for (const product of activity.products ?? []) {
      seenTypes.add(product.typeID)
      inventionRows.push({
        Type: nameOf(product.typeID),
        Blueprint: nameOf(blueprintId),
        BaseRuns: product.quantity,
        Datacore1: nameOf(d1.typeID),
        Datacore1Qty: d1.quantity,
        Datacore2: nameOf(d2.typeID),
        Datacore2Qty: d2.quantity,
        JobTime: activity.time,
        Probability: product.probability ?? 1,
      })
    }
  }

  for (const bp of survivors) {
    const activities = bp.activities ?? {}
    if (activities[MANUFACTURING]) collectIndustry(activities[MANUFACTURING], industryTypes)
    if (activities[REACTION]) collectIndustry(activities[REACTION], reactionTypes)
    if (activities[INVENTION]) collectInvention(activities[INVENTION], bp._key)
  }

  // Seed the type set with the decryptors (force-included in types.csv). A
  // rename in the SDE makes one unresolvable — log and skip rather than throw.
  for (const name of DECRYPTOR_NAMES) {
    const id = nameToId.get(name)
    if (id === undefined) console.warn(`sheet-csv: decryptor not found in SDE: ${name}`)
    else seenTypes.add(id)
  }

  // The group label for a type, shared by the pre-joined Group column and
  // types.csv. Reaction wins outright; otherwise miros components, then tech
  // level by metaGroupID, then Input (raw material) vs Tech I fall-through.
  const groupLabel = (typeId, mode) => {
    if (reactionTypes.has(typeId)) return 'Reaction'
    const t = typeData.get(typeId)
    const groupID = t?.groupID
    const metaGroupID = t?.metaGroupID
    if (mode === 'miros' && COMPONENT_GROUP_IDS.has(groupID)) return 'Component'
    if (metaGroupID === 1) return 'Tech I'
    if (metaGroupID === 2) return 'Tech II'
    if (metaGroupID === 3) return 'Tech III'
    if (metaGroupID == null) return industryTypes.has(typeId) ? 'Tech I' : 'Input'
    return 'Tech I'
  }

  const staticInputs = (mode) =>
    inputRows.map((r) => ({
      Group: groupLabel(r.outputId, mode),
      Type: nameOf(r.outputId),
      Material: r.materialName,
      InputQty: r.inputQty,
    }))

  const staticOutputs = (mode) =>
    outputRows.map((r) => ({
      Group: groupLabel(r.outputId, mode),
      Type: nameOf(r.outputId),
      OutputQty: r.outputQty,
      JobTime: r.jobTime,
    }))

  // types.csv: every referenced type (ascending id) present in the SDE.
  const typesCsv = (mode) => {
    const ids = [...seenTypes].filter((id) => typeData.has(id)).sort((a, b) => a - b)
    return ids.map((id) => {
      const t = typeData.get(id)
      const name = t.name?.en ?? `Type ${id}`
      const volume = name === OUTRIDER_BLUEPRINT_NAME ? OUTRIDER_BLUEPRINT_VOLUME : (t.volume ?? '')
      return { TypeID: id, Group: groupLabel(id, mode), Type: name, Volume: volume }
    })
  }

  return {
    'static-inputs-twines.csv': toCsv(staticInputs('twines')),
    'static-inputs-miros.csv': toCsv(staticInputs('miros')),
    'static-outputs-twines.csv': toCsv(staticOutputs('twines')),
    'static-outputs-miros.csv': toCsv(staticOutputs('miros')),
    'invention.csv': toCsv(inventionRows),
    'types-twines.csv': toCsv(typesCsv('twines')),
    'types-miros.csv': toCsv(typesCsv('miros')),
  }
}

// ── DB read ──────────────────────────────────────────────────────────────

// Page a mirror table, collecting each row's `data` jsonb (the raw SDE object,
// which carries `_key`). Same shape as buildEsfData.js's readMirror.
const readMirror = async (supabase, stem) => {
  const rows = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from(`sde_${stem}`)
      .select('data')
      .order('_key')
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(`sheet-csv: reading sde_${stem} failed: ${error.message}`)
    for (const row of data) rows.push(row.data)
    if (data.length < PAGE_SIZE) break
  }
  return rows
}

/** Read the mirror and build all seven CSVs. @returns {Promise<Record<string,string>>} */
export const encodeSheetCsv = async () => {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error(
      'sheet-csv: missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY (needed to read the sde_* mirror)'
    )
  }
  const { createClient } = await import('@supabase/supabase-js')
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  console.log('sheet-csv: reading sde_types and sde_blueprints from the mirror…')
  const [types, blueprints] = await Promise.all([readMirror(supabase, 'types'), readMirror(supabase, 'blueprints')])
  console.log(`sheet-csv: ${types.length} types, ${blueprints.length} blueprints`)
  return buildSheets({ types, blueprints })
}
