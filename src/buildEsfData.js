// Builds the 6 protobuf data files @eveshipfit/react's EveDataProvider
// expects (types/groups/marketGroups/typeDogma/dogmaEffects/dogmaAttributes)
// from the SDE, encoded per src/esf.proto (vendored from
// https://github.com/EVEShipFit/data). Reads its inputs from the
// nightly-mirrored sde_* tables in Supabase (populated by the sde-mirror
// workflow, src/jobs/sdeMirror.js) rather than downloading CCP's SDE zip at
// build time — no CCP download and no `unzip` binary dependency; the build
// consumes the same locally-mirrored SDE the runtime loaders (src/sde*.ts) do.
// Runs as the `predev`/`prebuild` step (see package.json) — re-run
// `pnpm run esf:build -- --force` to refresh mid-session.
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createClient } from '@supabase/supabase-js'
import protobuf from 'protobufjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROTO_PATH = join(__dirname, 'esf.proto')
const OUTPUT_DIR = join(__dirname, '..', 'public', 'esf-data')

// The SDE inputs come from the nightly-mirrored sde_* tables (public-read; the
// sde-mirror workflow ingests every CCP JSONL file — see src/jobs/sdeMirror.js).
// Each mirror row's `data` jsonb is the raw JSONL object, so the build*
// functions below consume it exactly as they did the downloaded file's lines.
// The sde_categories rows aren't encoded into a .pb2 — they only resolve the
// category-name targets in the eveship.fit patches below.
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_KEY
if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('esf: missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY (needed to read the sde_* mirror)')
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })

// PostgREST caps a response at 1000 rows, so page the mirror tables.
const PAGE_SIZE = 1000

// eveship.fit's dogma engine hard-depends on ~50 synthetic attributes/effects
// its own data pipeline patches into CCP's SDE (derived stats like ehp,
// damagePerSecond, alignTime — the engine resolves these BY NAME and panics
// if they're absent). src/esfPatches.json is the patch set from
// https://github.com/EVEShipFit/data (patches/*.yaml, converted to JSON;
// re-fetch + reconvert when bumping @eveshipfit/dogma-engine), and
// applyPatches() below is a port of that repo's convert/patches/*.py.
const PATCHES_PATH = join(__dirname, 'esfPatches.json')

// Page through a mirror table, yielding each row's `data` jsonb — the same raw
// SDE object the old readJsonl() yielded from the downloaded file, so the
// build* functions are unchanged. Ordered by _key for stable pagination.
const readMirror = async function* (stem) {
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from(`sde_${stem}`)
      .select('data')
      .order('_key')
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(`esf: reading sde_${stem} failed: ${error.message}`)
    for (const row of data) yield row.data
    if (data.length < PAGE_SIZE) break
  }
}

const en = (localized) => localized?.en ?? ''

// Builds { entries: { [id]: { name, categoryID, published } } } — groups
// need to be loaded before types, since a type's categoryID isn't stored
// directly on the type; it's looked up via its groupID here.
const buildGroups = async () => {
  const entries = {}
  for await (const g of readMirror('groups')) {
    entries[g._key] = { name: en(g.name), categoryID: g.categoryID, published: !!g.published }
  }
  return entries
}

const buildTypes = async (groups) => {
  const entries = {}
  for await (const t of readMirror('types')) {
    const group = groups[t.groupID]
    entries[t._key] = {
      name: en(t.name),
      groupID: t.groupID,
      categoryID: group?.categoryID ?? 0,
      published: !!t.published,
      factionID: t.factionID,
      marketGroupID: t.marketGroupID,
      metaGroupID: t.metaGroupID,
      capacity: t.capacity,
      mass: t.mass,
      radius: t.radius,
      volume: t.volume,
    }
  }
  return entries
}

const buildMarketGroups = async () => {
  const entries = {}
  for await (const mg of readMirror('market_groups')) {
    entries[mg._key] = { name: en(mg.name), parentGroupID: mg.parentGroupID, iconID: mg.iconID }
  }
  return entries
}

// dogmaAttributes.jsonl's plain "name" (e.g. "maxVelocity") is the internal
// identifier dogma-engine resolves attributes by — not the localized
// "displayName" shown to players.
const buildDogmaAttributes = async () => {
  const entries = {}
  for await (const a of readMirror('dogma_attributes')) {
    entries[a._key] = {
      name: a.name,
      published: !!a.published,
      defaultValue: a.defaultValue ?? 0,
      highIsGood: !!a.highIsGood,
      stackable: !!a.stackable,
    }
  }
  return entries
}

const buildDogmaEffects = async () => {
  const entries = {}
  for await (const e of readMirror('dogma_effects')) {
    entries[e._key] = {
      name: e.name,
      effectCategory: e.effectCategoryID,
      electronicChance: !!e.electronicChance,
      isAssistance: !!e.isAssistance,
      isOffensive: !!e.isOffensive,
      isWarpSafe: !!e.isWarpSafe,
      propulsionChance: !!e.propulsionChance,
      rangeChance: !!e.rangeChance,
      dischargeAttributeID: e.dischargeAttributeID,
      durationAttributeID: e.durationAttributeID,
      rangeAttributeID: e.rangeAttributeID,
      falloffAttributeID: e.falloffAttributeID,
      trackingSpeedAttributeID: e.trackingSpeedAttributeID,
      fittingUsageChanceAttributeID: e.fittingUsageChanceAttributeID,
      resistanceAttributeID: e.resistanceAttributeID,
      modifierInfo: e.modifierInfo,
    }
  }
  return entries
}

const buildTypeDogma = async () => {
  const entries = {}
  for await (const td of readMirror('type_dogma')) {
    entries[td._key] = {
      dogmaAttributes: (td.dogmaAttributes ?? []).map((a) => ({ attributeID: a.attributeID, value: a.value })),
      dogmaEffects: (td.dogmaEffects ?? []).map((e) => ({ effectID: e.effectID, isDefault: !!e.isDefault })),
    }
  }
  return entries
}

const buildCategories = async () => {
  const entries = {}
  for await (const c of readMirror('categories')) {
    entries[c._key] = { name: en(c.name), published: !!c.published }
  }
  return entries
}

// ── eveship.fit patch application ──────────────────────────────────────────
// A JS port of EVEShipFit/data's convert/patches/{dogma_attributes,
// dogma_effects,type_dogma}.py, applied to the same in-memory maps we encode.
// Order matters: attributes first (effects reference them by name), then
// effects (typeDogma references them by name), then typeDogma.

const EFFECT_CATEGORY_BY_NAME = {
  passive: 0,
  active: 1,
  target: 2,
  area: 3,
  online: 4,
  overload: 5,
  dungeon: 6,
  system: 7,
}
const OPERATION_BY_NAME = {
  preAssign: -1,
  preMul: 0,
  preDiv: 1,
  modAdd: 2,
  modSub: 3,
  postMul: 4,
  postDiv: 5,
  postPercent: 6,
  postAssign: 7,
}

const applyPatches = (patchGroups, { types, groups, categories, dogmaAttributes, dogmaEffects, typeDogma }) => {
  const must = (value, what) => {
    if (value === undefined) throw new Error(`esf patches: unknown ${what}`)
    return value
  }
  const attrIdByName = new Map(Object.entries(dogmaAttributes).map(([id, a]) => [a.name, Number(id)]))
  const effectIdByName = new Map(Object.entries(dogmaEffects).map(([id, e]) => [e.name, Number(id)]))

  // 1. New attributes get sequential negative IDs (none of the current
  // patches pin an explicit id).
  let nextAttributeID = -1
  for (const group of patchGroups) {
    for (const { new: meta, ...fields } of group.attributes) {
      if (attrIdByName.has(meta.name)) throw new Error(`esf patches: attribute name '${meta.name}' is not unique`)
      dogmaAttributes[nextAttributeID] = {
        name: meta.name,
        published: !!fields.published,
        defaultValue: fields.defaultValue ?? 0,
        highIsGood: !!fields.highIsGood,
        stackable: !!fields.stackable,
      }
      attrIdByName.set(meta.name, nextAttributeID)
      nextAttributeID -= 1
    }
  }

  // 2. Effects: resolve name references, then either add (negative ID) or
  // amend existing effects matched by name.
  const typeIdByName = new Map(Object.entries(types).map(([id, t]) => [t.name, Number(id)]))
  const fixupModifier = (m) => {
    const out = { domain: m.domain, func: m.func }
    if ('modifiedAttribute' in m)
      out.modifiedAttributeID = must(attrIdByName.get(m.modifiedAttribute), `attribute '${m.modifiedAttribute}'`)
    if ('modifiedAttributeID' in m) out.modifiedAttributeID = m.modifiedAttributeID
    if ('modifyingAttribute' in m)
      out.modifyingAttributeID = must(attrIdByName.get(m.modifyingAttribute), `attribute '${m.modifyingAttribute}'`)
    if ('modifyingAttributeID' in m) out.modifyingAttributeID = m.modifyingAttributeID
    if ('skillType' in m)
      out.skillTypeID =
        m.skillType === 'IfSkillRequired' ? -1 : must(typeIdByName.get(m.skillType), `skill '${m.skillType}'`)
    if ('groupID' in m) out.groupID = m.groupID
    if ('operation' in m) out.operation = must(OPERATION_BY_NAME[m.operation], `operation '${m.operation}'`)
    return out
  }
  let nextEffectID = -1
  for (const group of patchGroups) {
    for (const patch of group.effects) {
      const effectCategory =
        'effectCategory' in patch
          ? must(EFFECT_CATEGORY_BY_NAME[patch.effectCategory], `effect category '${patch.effectCategory}'`)
          : undefined
      const modifierInfo = (patch.modifierInfo ?? []).map(fixupModifier)
      if (patch.new) {
        if (effectIdByName.has(patch.new.name))
          throw new Error(`esf patches: effect name '${patch.new.name}' is not unique`)
        dogmaEffects[nextEffectID] = {
          name: patch.new.name,
          effectCategory: effectCategory ?? 0,
          electronicChance: !!patch.electronicChance,
          isAssistance: !!patch.isAssistance,
          isOffensive: !!patch.isOffensive,
          isWarpSafe: !!patch.isWarpSafe,
          propulsionChance: !!patch.propulsionChance,
          rangeChance: !!patch.rangeChance,
          modifierInfo,
        }
        effectIdByName.set(patch.new.name, nextEffectID)
        nextEffectID -= 1
      } else if (patch.patch) {
        for (const target of patch.patch) {
          const entry = dogmaEffects[must(effectIdByName.get(target.name), `effect '${target.name}'`)]
          if (modifierInfo.length > 0) entry.modifierInfo = [...(entry.modifierInfo ?? []), ...modifierInfo]
          if (effectCategory !== undefined) entry.effectCategory = effectCategory
          for (const key of [
            'electronicChance',
            'isAssistance',
            'isOffensive',
            'isWarpSafe',
            'propulsionChance',
            'rangeChance',
          ]) {
            if (key in patch) entry[key] = patch[key]
          }
        }
      }
    }
  }

  // 3. typeDogma: attach effects/attributes to every type matching the
  // patch's category/type target, optionally filtered by which attributes or
  // effects the type already carries.
  const categoryIdByName = new Map(Object.entries(categories).map(([id, c]) => [c.name, Number(id)]))
  const hasAttribute = (typeID, attributeID) =>
    (typeDogma[typeID]?.dogmaAttributes ?? []).some((a) => a.attributeID === attributeID)
  const hasEffect = (typeID, effectID) => (typeDogma[typeID]?.dogmaEffects ?? []).some((e) => e.effectID === effectID)

  for (const group of patchGroups) {
    for (const patch of group.typeDogma) {
      const attributes = (patch.dogmaAttributes ?? []).map((a) => ({
        attributeID: must(attrIdByName.get(a.attribute), `attribute '${a.attribute}'`),
        value: a.value,
      }))
      const effects = (patch.dogmaEffects ?? []).map((e) => ({
        effectID: must(effectIdByName.get(e.effect), `effect '${e.effect}'`),
        isDefault: !!e.isDefault,
      }))

      const appliedIDs = new Set()
      for (const target of patch.patch) {
        let typeIDs
        if ('category' in target) {
          const categoryID = must(categoryIdByName.get(target.category), `category '${target.category}'`)
          const groupIDs = new Set(
            Object.entries(groups)
              .filter(([, g]) => g.categoryID === categoryID)
              .map(([id]) => Number(id))
          )
          typeIDs = Object.entries(types)
            .filter(([, t]) => groupIDs.has(t.groupID))
            .map(([id]) => Number(id))
        } else if ('type' in target) {
          typeIDs = [must(typeIdByName.get(target.type), `type '${target.type}'`)]
        } else {
          throw new Error('esf patches: unknown patch target')
        }

        for (const typeID of typeIDs) {
          typeDogma[typeID] ??= { dogmaAttributes: [], dogmaEffects: [] }
        }

        for (const filter of target.hasAllAttributes ?? []) {
          const attributeID = must(attrIdByName.get(filter.name), `attribute '${filter.name}'`)
          typeIDs = typeIDs.filter((typeID) => hasAttribute(typeID, attributeID))
        }
        if (target.hasAnyAttributes) {
          const ids = target.hasAnyAttributes.map((f) => must(attrIdByName.get(f.name), `attribute '${f.name}'`))
          typeIDs = typeIDs.filter((typeID) => ids.some((attributeID) => hasAttribute(typeID, attributeID)))
        }
        if (target.hasAnyEffects) {
          const ids = target.hasAnyEffects.map((f) => must(effectIdByName.get(f.name), `effect '${f.name}'`))
          typeIDs = typeIDs.filter((typeID) => ids.some((effectID) => hasEffect(typeID, effectID)))
        }

        for (const typeID of typeIDs) {
          if (appliedIDs.has(typeID)) continue
          appliedIDs.add(typeID)
          typeDogma[typeID].dogmaAttributes.push(...attributes)
          typeDogma[typeID].dogmaEffects.push(...effects)
        }
      }
    }
  }
}

// Message.verify() doesn't accept string enum names (e.g. "shipID") in
// nested submessages the way fromObject() does, so skip it — fromObject()
// and encode() both throw on genuinely malformed data anyway.
const encodeMessage = (root, messageName, entries) => {
  const Message = root.lookupType(`esf.${messageName}`)
  return Message.encode(Message.fromObject({ entries })).finish()
}

// The six .pb2 files, in the (message, output filename) order they encode.
const FILES = [
  { messageName: 'Types', key: 'types', fileName: 'types.pb2' },
  { messageName: 'Groups', key: 'groups', fileName: 'groups.pb2' },
  { messageName: 'MarketGroups', key: 'marketGroups', fileName: 'marketGroups.pb2' },
  { messageName: 'DogmaAttributes', key: 'dogmaAttributes', fileName: 'dogmaAttributes.pb2' },
  { messageName: 'DogmaEffects', key: 'dogmaEffects', fileName: 'dogmaEffects.pb2' },
  { messageName: 'TypeDogma', key: 'typeDogma', fileName: 'typeDogma.pb2' },
]

// The six output filenames, for consumers that need the set before encoding
// (the esf_data freshness guard in src/jobs/esfData.js).
export const ESF_FILE_NAMES = FILES.map(({ fileName }) => fileName)

// Read the sde_* mirror, apply the eveship.fit patches, and encode the six
// protobuf files — returning { [fileName]: Buffer } without touching disk.
// Shared by the build-time step (run(), writes to public/esf-data/) and the
// nightly workflow job (src/jobs/esfData.js, upserts into the esf_data table).
export const encodeEsfData = async () => {
  console.log('esf: reading source tables from the sde_* mirror…')
  const groups = await buildGroups()
  const [types, categories, marketGroups, dogmaAttributes, dogmaEffects, typeDogma] = await Promise.all([
    buildTypes(groups),
    buildCategories(),
    buildMarketGroups(),
    buildDogmaAttributes(),
    buildDogmaEffects(),
    buildTypeDogma(),
  ])

  const patchGroups = JSON.parse(await readFile(PATCHES_PATH, 'utf8'))
  applyPatches(patchGroups, { types, groups, categories, dogmaAttributes, dogmaEffects, typeDogma })
  console.log(`esf: applied ${patchGroups.length} eveship.fit patch groups`)

  const entriesByKey = { types, groups, marketGroups, dogmaAttributes, dogmaEffects, typeDogma }
  const root = await protobuf.load(PROTO_PATH)
  const buffers = {}
  for (const { messageName, key, fileName } of FILES) {
    buffers[fileName] = encodeMessage(root, messageName, entriesByKey[key])
    console.log(`esf: encoded ${fileName} (${buffers[fileName].length} bytes, ${Object.keys(entriesByKey[key]).length} entries)`)
  }
  return buffers
}

const run = async () => {
  const force = process.argv.includes('--force')
  await mkdir(OUTPUT_DIR, { recursive: true })

  if (!force) {
    const allExist = await Promise.all(
      FILES.map(({ fileName }) =>
        access(join(OUTPUT_DIR, fileName)).then(
          () => true,
          () => false
        )
      )
    )
    if (allExist.every(Boolean)) {
      console.log(`esf: ${OUTPUT_DIR} already populated, skipping (pass --force to regenerate)`)
      return
    }
  }

  const buffers = await encodeEsfData()
  await Promise.all(
    FILES.map(({ fileName }) =>
      writeFile(join(OUTPUT_DIR, fileName), buffers[fileName]).then(() => console.log(`esf: wrote ${fileName}`))
    )
  )
}

// Only self-run as the build step when invoked as a CLI; when imported (by
// src/jobs/esfData.js for the workflow), just expose encodeEsfData().
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
