import { ascend, sortWith } from 'ramda'

import type { FittingItem } from './fit'

// EFT format — the plain-text fitting notation the in-game fitting window
// reads from the clipboard ("Import from clipboard"), and what every third
// party (Pyfa, zkillboard, forum posts) speaks:
//
//   [Rifter, Shield Rifter]
//
//   Nanofiber Internal Structure II
//   [Empty Low slot]
//
//   5MN Y-T8 Compact Microwarpdrive
//
//   200mm AutoCannon II, Republic Fleet EMP S
//
//   Small Projectile Burst Aerator II
//
//
//   Warrior II x2
//
//   Nanite Repair Paste x50
//
// Blocks run low → mid → high → rig → subsystem → service, then the bays and
// cargo, separated by blank lines. The block order is the importer's contract:
// it has no slot labels to go on, so it counts blank lines.

// The SDE categories this needs to tell apart. A charge shares its module's
// slot flag in an ESI fitting (that's how ESI says "loaded into"), so the two
// are only separable by category — and EFT wants them on one line, joined by
// a comma, rather than as two entries.
const CHARGE_CATEGORY_ID = 8

export type EftType = { name: string; categoryID: number | null }

// The fitted-slot blocks, in EFT's order. `empty` is the placeholder line the
// game itself writes for a slot the hull has but the fit leaves open.
const SLOT_BLOCKS: Array<{ prefix: string; empty: string }> = [
  { prefix: 'LoSlot', empty: '[Empty Low slot]' },
  { prefix: 'MedSlot', empty: '[Empty Med slot]' },
  { prefix: 'HiSlot', empty: '[Empty High slot]' },
  { prefix: 'RigSlot', empty: '[Empty Rig slot]' },
  { prefix: 'SubSystemSlot', empty: '[Empty Subsystem slot]' },
  { prefix: 'ServiceSlot', empty: '[Empty Service slot]' },
]

// The trailing quantity blocks, in EFT's order. Everything here is written
// "Name xN" rather than one line per unit.
const BAY_BLOCKS: Array<{ prefix: string }> = [{ prefix: 'DroneBay' }, { prefix: 'FighterBay' }, { prefix: 'Cargo' }]

const nameOf = (types: Record<number, EftType>, typeID: number): string =>
  types[typeID]?.name ?? `[Unknown type ${typeID}]`

const isCharge = (types: Record<number, EftType>, typeID: number): boolean =>
  types[typeID]?.categoryID === CHARGE_CATEGORY_ID

// The numeric suffix on a slot flag (HiSlot3 → 3). Anything unparseable sorts
// to the front rather than throwing off the whole block.
const slotIndex = (flag: string, prefix: string): number => {
  const n = Number.parseInt(flag.slice(prefix.length), 10)
  return Number.isFinite(n) ? n : 0
}

// One fitted-slot block. Empty indices *below* the highest occupied one are
// real holes in the fit and get a placeholder; anything above it is unknowable
// from the fitting alone (ESI never says how many slots the hull has), so the
// block simply ends. The importer is happy either way — it fills the rest.
const slotBlock = (items: FittingItem[], types: Record<number, EftType>, prefix: string, empty: string): string[] => {
  const inBlock = items.filter((item) => item.flag.startsWith(prefix))
  if (inBlock.length === 0) return []

  const highest = inBlock.reduce((max, item) => Math.max(max, slotIndex(item.flag, prefix)), 0)

  return Array.from({ length: highest + 1 }, (_unused, index) => {
    const atIndex = inBlock.filter((item) => slotIndex(item.flag, prefix) === index)
    const module = atIndex.find((item) => !isCharge(types, Number(item.type_id)))
    const charge = atIndex.find((item) => isCharge(types, Number(item.type_id)))
    if (!module) return empty
    const moduleName = nameOf(types, Number(module.type_id))
    return charge ? `${moduleName}, ${nameOf(types, Number(charge.type_id))}` : moduleName
  })
}

// One bay/cargo block. Identical stacks are folded together so a drone bay
// holding five Warrior IIs across two rows reads as one "Warrior II x5" line,
// the way the game writes it.
const bayBlock = (items: FittingItem[], types: Record<number, EftType>, prefix: string): string[] => {
  const inBlock = items.filter((item) => item.flag.startsWith(prefix))
  if (inBlock.length === 0) return []

  const stacked = inBlock.reduce<Map<number, number>>((acc, item) => {
    const typeID = Number(item.type_id)
    acc.set(typeID, (acc.get(typeID) ?? 0) + Number(item.quantity ?? 1))
    return acc
  }, new Map())

  const rows = Array.from(stacked, ([typeID, quantity]) => ({ name: nameOf(types, typeID), quantity }))
  return sortWith([ascend((row: { name: string }) => row.name)], rows).map(
    ({ name, quantity }) => `${name} x${quantity}`
  )
}

// The whole fit as EFT text. Pure — the caller resolves the type names and
// categories (SDE) and hands them in.
export const toEft = (
  fit: { name: string | null; ship_type_id: number | string; items: FittingItem[] | null },
  types: Record<number, EftType>
): string => {
  const items = fit.items ?? []
  const hull = nameOf(types, Number(fit.ship_type_id))
  const title = fit.name?.trim() || hull

  const blocks = [
    ...SLOT_BLOCKS.map(({ prefix, empty }) => slotBlock(items, types, prefix, empty)),
    ...BAY_BLOCKS.map(({ prefix }) => bayBlock(items, types, prefix)),
  ].filter((block) => block.length > 0)

  return [`[${hull}, ${title}]`, ...blocks.map((block) => block.join('\n'))].join('\n\n')
}
