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
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
// categories.jsonl isn't encoded into a .pb2 — it's only needed to resolve
// the category-name targets in the eveship.fit patches below.
const SOURCE_FILES = [
  'types.jsonl',
  'groups.jsonl',
  'categories.jsonl',
  'marketGroups.jsonl',
  'dogmaAttributes.jsonl',
  'dogmaEffects.jsonl',
  'typeDogma.jsonl',
]

// eveship.fit's dogma engine hard-depends on ~50 synthetic attributes/effects
// its own data pipeline patches into CCP's SDE (derived stats like ehp,
// damagePerSecond, alignTime — the engine resolves these BY NAME and panics
// if they're absent). src/esfPatches.json is the patch set from
// https://github.com/EVEShipFit/data (patches/*.yaml, converted to JSON;
// re-fetch + reconvert when bumping @eveshipfit/dogma-engine), and
// applyPatches() below is a port of that repo's convert/patches/*.py.
const PATCHES_PATH = join(__dirname, 'esfPatches.json')

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

const buildCategories = async (dir) => {
  const entries = {}
  for await (const c of readJsonl(join(dir, 'categories.jsonl'))) {
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
    const [types, categories, marketGroups, dogmaAttributes, dogmaEffects, typeDogma] = await Promise.all([
      buildTypes(workDir, groups),
      buildCategories(workDir),
      buildMarketGroups(workDir),
      buildDogmaAttributes(workDir),
      buildDogmaEffects(workDir),
      buildTypeDogma(workDir),
    ])

    const patchGroups = JSON.parse(await readFile(PATCHES_PATH, 'utf8'))
    applyPatches(patchGroups, { types, groups, categories, dogmaAttributes, dogmaEffects, typeDogma })
    console.log(`esf: applied ${patchGroups.length} eveship.fit patch groups`)

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
