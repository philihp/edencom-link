// Builds the 6 protobuf data files @eveshipfit/react's EveDataProvider
// expects (types/groups/marketGroups/typeDogma/dogmaEffects/dogmaAttributes)
// from CCP's official SDE export, encoded per src/esf.proto (vendored from
// https://github.com/EVEShipFit/data). Downloading eveshipfit's own
// pre-built copies isn't viable: data.eveship.fit 403s plain server-side
// fetches from Vercel's build network (datacenter-IP bot-blocking) — CCP's
// own export doesn't have that problem (buildSde.js already relies on the
// Fuzzwork mirror successfully at build time; this uses CCP's official
// export directly, matching every field the proto needs 1:1).
// Runs as a `predev`/`prebuild` step (see package.json) — re-run
// `pnpm run esf:build -- --force` to refresh mid-session.
import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import protobuf from 'protobufjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROTO_PATH = join(__dirname, 'esf.proto')
const OUTPUT_DIR = join(__dirname, '..', 'public', 'esf-data')

const SDE_URL = 'https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip'

// The CCP SDE tables needed to populate all 6 esf.proto messages (Types,
// Groups, MarketGroups, DogmaAttributes, DogmaEffects, TypeDogma).
const SOURCE_FILES = [
  'types.jsonl',
  'groups.jsonl',
  'marketGroups.jsonl',
  'dogmaAttributes.jsonl',
  'dogmaEffects.jsonl',
  'typeDogma.jsonl',
]

const readJsonl = async function* (path) {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
  for await (const line of rl) {
    if (line.trim()) yield JSON.parse(line)
  }
}

const en = (localized) => localized?.en ?? ''

const downloadSde = async (destZip) => {
  console.log(`esf: downloading SDE from ${SDE_URL}…`)
  const res = await fetch(SDE_URL, { redirect: 'follow' })
  if (!res.ok) throw new Error(`GET ${SDE_URL} → ${res.status}`)
  await writeFile(destZip, Buffer.from(await res.arrayBuffer()))
  console.log(`esf: downloaded SDE zip`)
}

const extractSources = (zipPath, destDir) =>
  new Promise((resolve, reject) => {
    const proc = spawn('unzip', ['-q', '-o', '-j', zipPath, ...SOURCE_FILES, '-d', destDir], { stdio: 'inherit' })
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`unzip exited ${code}`))))
  })

// Builds { entries: { [id]: { name, categoryID, published } } } — groups
// need to be loaded before types, since a type's categoryID isn't stored
// directly on the type; it's looked up via its groupID here.
const buildGroups = async (dir) => {
  const entries = {}
  for await (const g of readJsonl(join(dir, 'groups.jsonl'))) {
    entries[g._key] = { name: en(g.name), categoryID: g.categoryID, published: !!g.published }
  }
  return entries
}

const buildTypes = async (dir, groups) => {
  const entries = {}
  for await (const t of readJsonl(join(dir, 'types.jsonl'))) {
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

const buildMarketGroups = async (dir) => {
  const entries = {}
  for await (const mg of readJsonl(join(dir, 'marketGroups.jsonl'))) {
    entries[mg._key] = { name: en(mg.name), parentGroupID: mg.parentGroupID, iconID: mg.iconID }
  }
  return entries
}

// dogmaAttributes.jsonl's plain "name" (e.g. "maxVelocity") is the internal
// identifier dogma-engine resolves attributes by — not the localized
// "displayName" shown to players.
const buildDogmaAttributes = async (dir) => {
  const entries = {}
  for await (const a of readJsonl(join(dir, 'dogmaAttributes.jsonl'))) {
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

const buildDogmaEffects = async (dir) => {
  const entries = {}
  for await (const e of readJsonl(join(dir, 'dogmaEffects.jsonl'))) {
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

const buildTypeDogma = async (dir) => {
  const entries = {}
  for await (const td of readJsonl(join(dir, 'typeDogma.jsonl'))) {
    entries[td._key] = {
      dogmaAttributes: (td.dogmaAttributes ?? []).map((a) => ({ attributeID: a.attributeID, value: a.value })),
      dogmaEffects: (td.dogmaEffects ?? []).map((e) => ({ effectID: e.effectID, isDefault: !!e.isDefault })),
    }
  }
  return entries
}

// Message.verify() doesn't accept string enum names (e.g. "shipID") in
// nested submessages the way fromObject() does, so skip it — fromObject()
// and encode() both throw on genuinely malformed data anyway.
const encodeAndWrite = (root, messageName, entries, fileName) => {
  const Message = root.lookupType(`esf.${messageName}`)
  const buffer = Message.encode(Message.fromObject({ entries })).finish()
  return writeFile(join(OUTPUT_DIR, fileName), buffer).then(() => {
    console.log(`esf: wrote ${fileName} (${buffer.length} bytes, ${Object.keys(entries).length} entries)`)
  })
}

const run = async () => {
  const force = process.argv.includes('--force')
  await mkdir(OUTPUT_DIR, { recursive: true })

  if (!force) {
    const allExist = await Promise.all(
      ['types', 'groups', 'marketGroups', 'typeDogma', 'dogmaEffects', 'dogmaAttributes'].map((name) =>
        access(join(OUTPUT_DIR, `${name}.pb2`)).then(
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

  const workDir = await mkdtemp(join(tmpdir(), 'esf-sde-'))
  try {
    const zipPath = join(workDir, 'sde.zip')
    await downloadSde(zipPath)
    console.log('esf: extracting source tables…')
    await extractSources(zipPath, workDir)

    const groups = await buildGroups(workDir)
    const [types, marketGroups, dogmaAttributes, dogmaEffects, typeDogma] = await Promise.all([
      buildTypes(workDir, groups),
      buildMarketGroups(workDir),
      buildDogmaAttributes(workDir),
      buildDogmaEffects(workDir),
      buildTypeDogma(workDir),
    ])

    const root = await protobuf.load(PROTO_PATH)
    await Promise.all([
      encodeAndWrite(root, 'Types', types, 'types.pb2'),
      encodeAndWrite(root, 'Groups', groups, 'groups.pb2'),
      encodeAndWrite(root, 'MarketGroups', marketGroups, 'marketGroups.pb2'),
      encodeAndWrite(root, 'DogmaAttributes', dogmaAttributes, 'dogmaAttributes.pb2'),
      encodeAndWrite(root, 'DogmaEffects', dogmaEffects, 'dogmaEffects.pb2'),
      encodeAndWrite(root, 'TypeDogma', typeDogma, 'typeDogma.pb2'),
    ])
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
