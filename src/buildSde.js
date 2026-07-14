// Generates src/generated/sdeTypes.json, src/generated/sdeSystems.json,
// src/generated/sdeStations.json, src/generated/sdeBlueprints.json, and
// src/generated/sdePlanets.json from CCP's official Static Data Export so the
// app can resolve type names/groups/categories, solar-system names, NPC station
// names, blueprint material bills, and planet system/index/type locally instead
// of depending on a remote service or DB round trip. Runs as a `predev`/`prebuild` step (see package.json) —
// re-run `pnpm run sde:build -- --force` to refresh the data. Mirrors
// buildEsfData.js's download/extract approach (same source zip, unzipped via
// the system `unzip` binary — already required for that script to work).
import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import { universeNames } from './esi.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TYPES_OUTPUT_PATH = join(__dirname, 'generated', 'sdeTypes.json')
const SYSTEMS_OUTPUT_PATH = join(__dirname, 'generated', 'sdeSystems.json')
const STATIONS_OUTPUT_PATH = join(__dirname, 'generated', 'sdeStations.json')
const BLUEPRINTS_OUTPUT_PATH = join(__dirname, 'generated', 'sdeBlueprints.json')
const PLANETS_OUTPUT_PATH = join(__dirname, 'generated', 'sdePlanets.json')

// CCP's own Static Data Export: one zip of per-dataset JSONL files, refreshed
// each game patch (see developers.eveonline.com/docs/services/static-data).
const SDE_URL = 'https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip'

const SOURCE_FILES = [
  'types.jsonl',
  'groups.jsonl',
  'mapSolarSystems.jsonl',
  'npcStations.jsonl',
  'blueprints.jsonl',
  'mapPlanets.jsonl',
]

const downloadSde = async (destZip) => {
  console.log(`sde: downloading SDE from ${SDE_URL}…`)
  const res = await fetch(SDE_URL, { redirect: 'follow' })
  if (!res.ok) throw new Error(`GET ${SDE_URL} → ${res.status}`)
  await writeFile(destZip, Buffer.from(await res.arrayBuffer()))
  console.log('sde: downloaded SDE zip')
}

const extractSources = (zipPath, destDir) =>
  new Promise((resolve, reject) => {
    const proc = spawn('unzip', ['-q', '-o', '-j', zipPath, ...SOURCE_FILES, '-d', destDir], { stdio: 'inherit' })
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`unzip exited ${code}`))))
  })

const readJsonl = async function* (path) {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
  for await (const line of rl) {
    if (line.trim()) yield JSON.parse(line)
  }
}

const en = (localized) => localized?.en ?? ''

const buildTypes = async (dir) => {
  console.log('sde: parsing types/groups from the SDE…')
  const categoryIDByGroup = new Map()
  for await (const g of readJsonl(join(dir, 'groups.jsonl'))) categoryIDByGroup.set(g._key, g.categoryID ?? null)

  // [typeID, name, groupID, categoryID] tuples, published types only — this is
  // the same "curated" cut the old remote service exposed.
  const out = []
  for await (const t of readJsonl(join(dir, 'types.jsonl'))) {
    const name = en(t.name)
    if (t.published && name.trim() !== '') out.push([t._key, name, t.groupID, categoryIDByGroup.get(t.groupID) ?? null])
  }
  out.sort((a, b) => a[0] - b[0])

  await writeFile(TYPES_OUTPUT_PATH, JSON.stringify(out))
  console.log(`sde: wrote ${out.length} types to ${TYPES_OUTPUT_PATH}`)
}

// Standard known-space systems live in the 30M id range; wormhole (31M) and
// abyssal (32M+) systems never appear in the industry cost-index feed, so they
// are left out of the watchable set.
const KSPACE_MIN = 30_000_000
const KSPACE_MAX = 31_000_000

const buildSystems = async (dir) => {
  console.log('sde: parsing solar systems from the SDE…')

  // [solarSystemID, name, security] tuples. Security is the raw SDE float,
  // rounded for display by the consumer.
  const out = []
  for await (const s of readJsonl(join(dir, 'mapSolarSystems.jsonl'))) {
    const name = en(s.name)
    if (s._key >= KSPACE_MIN && s._key < KSPACE_MAX && name.trim() !== '') out.push([s._key, name, s.securityStatus])
  }
  out.sort((a, b) => a[0] - b[0])

  await writeFile(SYSTEMS_OUTPUT_PATH, JSON.stringify(out))
  console.log(`sde: wrote ${out.length} solar systems to ${SYSTEMS_OUTPUT_PATH}`)
}

// ESI /universe/names/ rejects more than 1000 ids per call.
const ESI_NAMES_BATCH_SIZE = 1000

// NPC stations only — conquerable outposts (player-held stations) were
// removed from the game years ago, so every station id ESI can return is
// static SDE data and never needs an ESI/DB fallback.
const buildStations = async (dir) => {
  console.log('sde: parsing NPC stations from the SDE…')
  const stations = []
  for await (const s of readJsonl(join(dir, 'npcStations.jsonl'))) stations.push([s._key, s.solarSystemID])

  // The SDE carries each station's structure (system, type, owning corp,
  // operation) but not its display name — that's generated client-side from
  // those pieces plus the celestial it orbits. Resolving via ESI's public
  // /universe/names/ sidesteps reimplementing that naming algorithm.
  const nameById = new Map()
  const ids = stations.map(([id]) => id)
  for (let i = 0; i < ids.length; i += ESI_NAMES_BATCH_SIZE) {
    const batch = ids.slice(i, i + ESI_NAMES_BATCH_SIZE)
    const resolved = await universeNames(batch)
    for (const r of resolved) nameById.set(r.id, r.name)
  }

  // [stationID, name, solarSystemID] tuples.
  const out = stations
    .map(([id, systemId]) => [id, nameById.get(id), systemId])
    .filter(([id, name, systemId]) => Number.isFinite(id) && Number.isFinite(systemId) && (name ?? '').trim() !== '')
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
const BLUEPRINT_ACTIVITIES = { manufacturing: MANUFACTURING, reaction: REACTION }

const buildBlueprints = async (dir) => {
  console.log('sde: parsing blueprints from the SDE…')

  // One tuple per (blueprint, activity, product):
  // [blueprintTypeID, activityID, productTypeID, productQuantity, [[matTypeID, qty], …]]
  const out = []
  for await (const bp of readJsonl(join(dir, 'blueprints.jsonl'))) {
    for (const [key, activityID] of Object.entries(BLUEPRINT_ACTIVITIES)) {
      const activity = bp.activities?.[key]
      if (!activity?.products?.length) continue
      const materials = (activity.materials ?? []).map((m) => [m.typeID, m.quantity]).sort((a, b) => a[0] - b[0])
      for (const product of activity.products) {
        out.push([bp._key, activityID, product.typeID, product.quantity, materials])
      }
    }
  }
  out.sort((a, b) => a[2] - b[2] || a[0] - b[0])

  await writeFile(BLUEPRINTS_OUTPUT_PATH, JSON.stringify(out))
  console.log(`sde: wrote ${out.length} blueprints to ${BLUEPRINTS_OUTPUT_PATH}`)
}

// A planet carries no display name in the SDE — EVE derives it as
// "<system name> <roman(celestialIndex)>", so the consumer (src/sdePlanets.ts)
// reconstructs it from the system name + celestial index. typeID is the planet
// type (11 = Temperate), kept so callers can filter by planet type.
const buildPlanets = async (dir) => {
  console.log('sde: parsing planets from the SDE…')

  // [planetID, solarSystemID, celestialIndex, typeID] tuples.
  const out = []
  for await (const p of readJsonl(join(dir, 'mapPlanets.jsonl'))) {
    if (Number.isFinite(p._key) && Number.isFinite(p.solarSystemID)) {
      out.push([p._key, p.solarSystemID, p.celestialIndex ?? null, p.typeID ?? null])
    }
  }
  out.sort((a, b) => a[0] - b[0])

  await writeFile(PLANETS_OUTPUT_PATH, JSON.stringify(out))
  console.log(`sde: wrote ${out.length} planets to ${PLANETS_OUTPUT_PATH}`)
}

const run = async () => {
  const force = process.argv.includes('--force')
  const artifacts = [
    [TYPES_OUTPUT_PATH, buildTypes],
    [SYSTEMS_OUTPUT_PATH, buildSystems],
    [STATIONS_OUTPUT_PATH, buildStations],
    [BLUEPRINTS_OUTPUT_PATH, buildBlueprints],
    [PLANETS_OUTPUT_PATH, buildPlanets],
  ]

  await mkdir(dirname(TYPES_OUTPUT_PATH), { recursive: true })

  const pending = []
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
    pending.push(build)
  }
  if (pending.length === 0) return

  const workDir = await mkdtemp(join(tmpdir(), 'sde-'))
  try {
    const zipPath = join(workDir, 'sde.zip')
    await downloadSde(zipPath)
    console.log('sde: extracting source tables…')
    await extractSources(zipPath, workDir)

    for (const build of pending) await build(workDir)
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
