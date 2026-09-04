import { decodeEntries } from './protobuf'
import * as schema from './schema'

// Our own replacement for @eveshipfit/react's EveDataProvider: fetch the six
// `.pb2` files from /esf/ and decode them into the `EveData` shape the WASM
// dogma engine's data callbacks read (see ./dogma.ts). No React involved — a
// module-level promise, so the several-MB decode happens once per page load
// and any second caller awaits the same result.

export type EsfType = {
  name: string
  groupID: number
  categoryID: number
  published: boolean
  factionID?: number
  marketGroupID?: number
  metaGroupID?: number
  capacity?: number
  mass?: number
  radius?: number
  volume?: number
}

export type EsfGroup = { name: string; categoryID: number; published: boolean }
export type EsfMarketGroup = { name: string; parentGroupID?: number; iconID?: number }

export type EsfTypeDogmaAttribute = { attributeID: number; value: number }
export type EsfTypeDogmaEffect = { effectID: number; isDefault: boolean }
export type EsfTypeDogma = {
  dogmaAttributes: EsfTypeDogmaAttribute[]
  dogmaEffects: EsfTypeDogmaEffect[]
}

export type EsfDogmaAttribute = {
  name: string
  published: boolean
  defaultValue: number
  highIsGood: boolean
  stackable: boolean
}

export type EsfModifierInfo = {
  domain: number
  func: number
  modifiedAttributeID?: number
  modifyingAttributeID?: number
  operation?: number
  groupID?: number
  skillTypeID?: number
}

export type EsfDogmaEffect = {
  name: string
  effectCategory: number
  electronicChance: boolean
  isAssistance: boolean
  isOffensive: boolean
  isWarpSafe: boolean
  propulsionChance: boolean
  rangeChance: boolean
  dischargeAttributeID?: number
  durationAttributeID?: number
  rangeAttributeID?: number
  falloffAttributeID?: number
  trackingSpeedAttributeID?: number
  fittingUsageChanceAttributeID?: number
  resistanceAttributeID?: number
  modifierInfo?: EsfModifierInfo[]
}

export type EveData = {
  types: Record<string, EsfType>
  groups: Record<string, EsfGroup>
  marketGroups: Record<string, EsfMarketGroup>
  typeDogma: Record<string, EsfTypeDogma>
  dogmaAttributes: Record<string, EsfDogmaAttribute>
  dogmaEffects: Record<string, EsfDogmaEffect>
  // name → id reverse indexes, built once here so neither the stats readout
  // nor the engine's `*_name_to_id` callbacks have to scan.
  attributeMapping: Record<string, number>
  effectMapping: Record<string, number>
  typeMapping: Record<string, number>
}

// The SDE category id for skills — every type in it is passed to the engine as
// a trained skill (see ./dogma.ts).
export const SKILL_CATEGORY_ID = 16

const fetchEntries = async <T>(dataUrl: string, name: string, spec: (typeof schema)[keyof typeof schema]) => {
  const response = await fetch(`${dataUrl}${name}.pb2`)
  if (!response.ok) throw new Error(`esf: fetching ${name}.pb2 failed with ${response.status}`)
  return decodeEntries<T>(new Uint8Array(await response.arrayBuffer()), spec)
}

// First id wins for a duplicated name — the same thing the upstream provider's
// scan-and-return-first does, since integer-like keys iterate ascending.
const invert = (entries: Record<string, { name: string }>): Record<string, number> => {
  const mapping: Record<string, number> = {}
  for (const id in entries) {
    const { name } = entries[id]
    if (mapping[name] === undefined) mapping[name] = parseInt(id)
  }
  return mapping
}

const load = async (dataUrl: string): Promise<EveData> => {
  const [types, groups, marketGroups, typeDogma, dogmaAttributes, dogmaEffects] = await Promise.all([
    fetchEntries<EsfType>(dataUrl, 'types', schema.type),
    fetchEntries<EsfGroup>(dataUrl, 'groups', schema.group),
    fetchEntries<EsfMarketGroup>(dataUrl, 'marketGroups', schema.marketGroup),
    fetchEntries<EsfTypeDogma>(dataUrl, 'typeDogma', schema.typeDogmaEntry),
    fetchEntries<EsfDogmaAttribute>(dataUrl, 'dogmaAttributes', schema.dogmaAttribute),
    fetchEntries<EsfDogmaEffect>(dataUrl, 'dogmaEffects', schema.dogmaEffect),
  ])

  return {
    types,
    groups,
    marketGroups,
    typeDogma,
    dogmaAttributes,
    dogmaEffects,
    attributeMapping: invert(dogmaAttributes),
    effectMapping: invert(dogmaEffects),
    typeMapping: invert(types),
  }
}

let cached: Promise<EveData> | null = null

// `/esf/` serves the .pb2 from the esf_data table (refreshed by the sde-mirror
// workflow), not the build-time static files — see src/app/esf/[file]/route.ts.
export const loadEveData = (dataUrl = '/esf/'): Promise<EveData> => {
  cached ??= load(dataUrl)
  return cached
}
