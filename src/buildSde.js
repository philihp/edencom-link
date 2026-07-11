// Generates src/generated/sdeTypes.json, src/generated/sdeSystems.json, and
// src/generated/sdeStations.json from CCP's Static Data Export so the app can
// resolve type names/groups/categories, solar-system names, and NPC station
// names locally instead of depending on a remote service or DB round trip.
// Runs as a `predev`/`prebuild` step (see package.json) — re-run
// `pnpm run sde:build -- --force` to refresh the data.
import { access, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TYPES_OUTPUT_PATH = join(__dirname, 'generated', 'sdeTypes.json')
const SYSTEMS_OUTPUT_PATH = join(__dirname, 'generated', 'sdeSystems.json')
const STATIONS_OUTPUT_PATH = join(__dirname, 'generated', 'sdeStations.json')
const BLUEPRINTS_OUTPUT_PATH = join(__dirname, 'generated', 'sdeBlueprints.json')

// Fuzzwork republishes CCP's SDE as flat CSVs, refreshed shortly after each
// game patch — much smaller and faster to fetch than CCP's own multi-file zip.
const TYPES_URL = 'https://www.fuzzwork.co.uk/dump/latest/csv/invTypes.csv'
const GROUPS_URL = 'https://www.fuzzwork.co.uk/dump/latest/csv/invGroups.csv'
const SYSTEMS_URL = 'https://www.fuzzwork.co.uk/dump/latest/csv/mapSolarSystems.csv'
const STATIONS_URL = 'https://www.fuzzwork.co.uk/dump/latest/csv/staStations.csv'
const BLUEPRINT_PRODUCTS_URL = 'https://www.fuzzwork.co.uk/dump/latest/csv/industryActivityProducts.csv'
const BLUEPRINT_MATERIALS_URL = 'https://www.fuzzwork.co.uk/dump/latest/csv/industryActivityMaterials.csv'

// Minimal RFC 4180 CSV parser: invTypes' description column embeds raw commas
// and newlines inside quoted fields, so a naive line/comma split corrupts rows.
const parseCsv = (text) => {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"'
        i += 1
      } else if (c === '"') {
        inQuotes = false
      } else {
        field += c
      }
      continue
    }
    if (c === '"') inQuotes = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\r') continue
    else if (c === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += c
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

const BOM = String.fromCharCode(0xfeff)

const fetchRecords = async (url) => {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`)
  const text = await res.text()
  const rows = parseCsv(text.startsWith(BOM) ? text.slice(1) : text)
  const [header, ...body] = rows
  return body.filter((r) => r.length === header.length).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])))
}

const buildTypes = async () => {
  console.log('sde: downloading invTypes/invGroups from the SDE…')
  const [types, groups] = await Promise.all([fetchRecords(TYPES_URL), fetchRecords(GROUPS_URL)])
  const categoryIDByGroup = new Map(groups.map((g) => [g.groupID, Number(g.categoryID)]))

  // [typeID, name, groupID, categoryID] tuples, published types only — this is
  // the same "curated" cut the old remote service exposed.
  const out = types
    .filter((t) => t.published === '1' && t.typeName.trim() !== '')
    .map((t) => [Number(t.typeID), t.typeName, Number(t.groupID), categoryIDByGroup.get(t.groupID) ?? null])
    .sort((a, b) => a[0] - b[0])

  await writeFile(TYPES_OUTPUT_PATH, JSON.stringify(out))
  console.log(`sde: wrote ${out.length} types to ${TYPES_OUTPUT_PATH}`)
}

// Standard known-space systems live in the 30M id range; wormhole (31M) and
// abyssal (32M+) systems never appear in the industry cost-index feed, so they
// are left out of the watchable set.
const KSPACE_MIN = 30_000_000
const KSPACE_MAX = 31_000_000

const buildSystems = async () => {
  console.log('sde: downloading mapSolarSystems from the SDE…')
  const systems = await fetchRecords(SYSTEMS_URL)

  // [solarSystemID, name, security] tuples. Security is the raw SDE float,
  // rounded for display by the consumer.
  const out = systems
    .map((s) => [Number(s.solarSystemID), s.solarSystemName, Number(s.security)])
    .filter(([id, name]) => id >= KSPACE_MIN && id < KSPACE_MAX && name.trim() !== '')
    .sort((a, b) => a[0] - b[0])

  await writeFile(SYSTEMS_OUTPUT_PATH, JSON.stringify(out))
  console.log(`sde: wrote ${out.length} solar systems to ${SYSTEMS_OUTPUT_PATH}`)
}

// NPC stations only — conquerable outposts (player-held stations) were
// removed from the game years ago, so every station id ESI can return is
// static SDE data and never needs an ESI/DB fallback.
const buildStations = async () => {
  console.log('sde: downloading staStations from the SDE…')
  const stations = await fetchRecords(STATIONS_URL)

  // [stationID, name, solarSystemID] tuples.
  const out = stations
    .map((s) => [Number(s.stationID), s.stationName, Number(s.solarSystemID)])
    .filter(([id, name, systemId]) => Number.isFinite(id) && Number.isFinite(systemId) && name.trim() !== '')
    .sort((a, b) => a[0] - b[0])

  await writeFile(STATIONS_OUTPUT_PATH, JSON.stringify(out))
  console.log(`sde: wrote ${out.length} stations to ${STATIONS_OUTPUT_PATH}`)
}

// EVE industry activity ids we model as "consume materials → produce output":
// manufacturing and reactions. Invention (8), copying (5), and research (3/4)
// are deliberately excluded — they don't turn a material bill into a product
// the way the eve-industry cost modifiers assume.
const MANUFACTURING = 1
const REACTION = 11
const BLUEPRINT_ACTIVITIES = new Set([MANUFACTURING, REACTION])

const buildBlueprints = async () => {
  console.log('sde: downloading industryActivityProducts/Materials from the SDE…')
  const [products, materials] = await Promise.all([
    fetchRecords(BLUEPRINT_PRODUCTS_URL),
    fetchRecords(BLUEPRINT_MATERIALS_URL),
  ])

  // Group materials by "<blueprintTypeID>:<activityID>" so each blueprint's
  // input bill is assembled in one pass rather than re-scanning per product.
  const key = (typeID, activityID) => `${typeID}:${activityID}`
  const materialsByActivity = new Map()
  for (const m of materials) {
    const activityID = Number(m.activityID)
    if (!BLUEPRINT_ACTIVITIES.has(activityID)) continue
    const k = key(m.typeID, m.activityID)
    const list = materialsByActivity.get(k) ?? []
    list.push([Number(m.materialTypeID), Number(m.quantity)])
    materialsByActivity.set(k, list)
  }

  // One tuple per (blueprint, activity) that yields a product:
  // [blueprintTypeID, activityID, productTypeID, productQuantity, [[matTypeID, qty], …]]
  const out = products
    .filter((p) => BLUEPRINT_ACTIVITIES.has(Number(p.activityID)))
    .map((p) => [
      Number(p.typeID),
      Number(p.activityID),
      Number(p.productTypeID),
      Number(p.quantity),
      (materialsByActivity.get(key(p.typeID, p.activityID)) ?? []).sort((a, b) => a[0] - b[0]),
    ])
    .sort((a, b) => a[2] - b[2] || a[0] - b[0])

  await writeFile(BLUEPRINTS_OUTPUT_PATH, JSON.stringify(out))
  console.log(`sde: wrote ${out.length} blueprints to ${BLUEPRINTS_OUTPUT_PATH}`)
}

const run = async () => {
  const force = process.argv.includes('--force')
  const artifacts = [
    [TYPES_OUTPUT_PATH, buildTypes],
    [SYSTEMS_OUTPUT_PATH, buildSystems],
    [STATIONS_OUTPUT_PATH, buildStations],
    [BLUEPRINTS_OUTPUT_PATH, buildBlueprints],
  ]

  await mkdir(dirname(TYPES_OUTPUT_PATH), { recursive: true })
  for (const [path, build] of artifacts) {
    if (!force) {
      const exists = await access(path).then(
        () => true,
        () => false
      )
      if (exists) {
        console.log(`sde: ${path} already exists, skipping (pass --force to regenerate)`)
        continue
      }
    }
    await build()
  }
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
