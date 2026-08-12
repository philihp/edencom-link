import type { EveData } from './eveData'

// ESI's fitting JSON, as `toEsiFit` in ../../ship/[itemId]/esfFit.ts builds it
// from a ship's asset rows. Declared here rather than imported from
// @eveshipfit/react: it's ESI's shape, not that package's, and this stack is
// meant to outlive the dependency (docs/custom-fit-ui.md, stage 4).
export type EsiFit = {
  name: string
  description: string
  ship_type_id: number
  items: { item_id: number; type_id: number; flag: number | string; quantity: number }[]
}

// Ported from @eveshipfit/react's ImportEsiFitting hook (MIT): turn the ESI
// fitting JSON we build from a ship's asset rows into the fit shape the WASM
// dogma engine takes.
//
// Two conversions live here because they're two halves of one mapping and
// neither is useful alone: ESI location flags → slot type + index, and the
// resulting fit → the engine's snake_case input.

export type SlotType = 'High' | 'Medium' | 'Low' | 'Rig' | 'SubSystem'
export type Slot = { type: SlotType; index: number }

export type EsfModule = { typeId: number; slot: Slot; charge?: { typeId: number } }
export type EsfDrone = { typeId: number; active: number; passive: number }
export type EsfCargo = { typeId: number; quantity: number }

export type EsfFit = {
  name: string
  shipTypeId: number
  modules: EsfModule[]
  drones: EsfDrone[]
  cargo: EsfCargo[]
}

// ESI reports a flag as a name on assets and as a number on saved fittings;
// both forms appear in our data, so both resolve here.
const FLAG_ID_TO_NAME: Record<number, string> = {
  5: 'Cargo',
  11: 'LoSlot0',
  12: 'LoSlot1',
  13: 'LoSlot2',
  14: 'LoSlot3',
  15: 'LoSlot4',
  16: 'LoSlot5',
  17: 'LoSlot6',
  18: 'LoSlot7',
  19: 'MedSlot0',
  20: 'MedSlot1',
  21: 'MedSlot2',
  22: 'MedSlot3',
  23: 'MedSlot4',
  24: 'MedSlot5',
  25: 'MedSlot6',
  26: 'MedSlot7',
  27: 'HiSlot0',
  28: 'HiSlot1',
  29: 'HiSlot2',
  30: 'HiSlot3',
  31: 'HiSlot4',
  32: 'HiSlot5',
  33: 'HiSlot6',
  34: 'HiSlot7',
  87: 'DroneBay',
  92: 'RigSlot0',
  93: 'RigSlot1',
  94: 'RigSlot2',
  125: 'SubSystemSlot0',
  126: 'SubSystemSlot1',
  127: 'SubSystemSlot2',
  128: 'SubSystemSlot3',
}

// Flag prefix → slot type. The trailing digit is the zero-based slot number;
// the engine's indexes are one-based, hence the +1 below.
const SLOT_PREFIXES: [string, SlotType][] = [
  ['LoSlot', 'Low'],
  ['MedSlot', 'Medium'],
  ['HiSlot', 'High'],
  ['RigSlot', 'Rig'],
  ['SubSystemSlot', 'SubSystem'],
]

export type Placement = { kind: 'module'; slot: Slot } | { kind: 'cargo' } | { kind: 'drone' }

// Anything not fitted, carried or in the drone bay (a ship maintenance bay,
// fuel bay, fleet hangar, …) has no bearing on the fit and returns undefined.
export const placementForFlag = (flag: number | string): Placement | undefined => {
  const name = typeof flag === 'number' ? FLAG_ID_TO_NAME[flag] : flag
  if (name === undefined) return undefined
  if (name === 'Cargo') return { kind: 'cargo' }
  if (name === 'DroneBay') return { kind: 'drone' }

  for (const [prefix, type] of SLOT_PREFIXES) {
    if (!name.startsWith(prefix)) continue
    const index = Number(name.slice(prefix.length))
    // Guard the suffix rather than trusting the prefix: `RigSlotX` from a
    // future flag would otherwise land in slot NaN.
    if (!Number.isInteger(index) || index < 0) return undefined
    return { kind: 'module', slot: { type, index: index + 1 } }
  }

  return undefined
}

// A ship's rows carry one item per stack, so the same drone type or cargo item
// can appear more than once (two stacks of the same drone in the bay). The
// engine wants one entry per type, as upstream's CleanImportFit does.
const accumulate = <T extends { typeId: number }>(items: T[], merge: (into: T, from: T) => void): T[] =>
  items.reduce<T[]>((acc, item) => {
    const existing = acc.find((candidate) => candidate.typeId === item.typeId)
    if (existing) merge(existing, item)
    else acc.push({ ...item })
    return acc
  }, [])

// The SDE category id for Charge — ammunition, scripts, probes.
export const CHARGE_CATEGORY_ID = 8

// Loaded ammunition is a hangar row like any other, carrying the *slot's* flag
// rather than one of its own, so a loaded launcher and its missiles both come
// through as `HiSlot0`. Upstream's ESI import maps each of them to a module,
// which lands two "modules" in one slot and makes the engine report the weapon
// as unarmed — a fitted, loaded Rifter reads 0 dps in the current viewer.
// Route a charge onto the module sharing its slot instead. A charge whose slot
// holds no module (ammo left behind by an unfitted weapon) is dropped: it isn't
// loaded into anything, so it changes nothing.
const attachCharges = (
  modules: { typeId: number; slot: Slot; charge?: { typeId: number } }[],
  charges: { typeId: number; slot: Slot }[]
): EsfModule[] => {
  for (const charge of charges) {
    const module = modules.find(
      (candidate) => candidate.slot.type === charge.slot.type && candidate.slot.index === charge.slot.index
    )
    // Multiple charges in one slot (a partly-swapped ammo load) can't be
    // represented; the first one wins, as the module can only hold one.
    if (module && module.charge === undefined) module.charge = { typeId: charge.typeId }
  }
  return modules
}

export const esiFitToEsfFit = (esiFit: EsiFit, eveData: EveData): EsfFit => {
  const placed = esiFit.items.map((item) => ({
    item,
    placement: placementForFlag(item.flag),
    isCharge: eveData.types[item.type_id]?.categoryID === CHARGE_CATEGORY_ID,
  }))

  const modules = placed.flatMap(({ item, placement, isCharge }) =>
    placement?.kind === 'module' && !isCharge ? [{ typeId: item.type_id, slot: placement.slot }] : []
  )
  const charges = placed.flatMap(({ item, placement, isCharge }) =>
    placement?.kind === 'module' && isCharge ? [{ typeId: item.type_id, slot: placement.slot }] : []
  )
  const drones = placed.flatMap(({ item, placement }) =>
    placement?.kind === 'drone' ? [{ typeId: item.type_id, active: item.quantity, passive: 0 }] : []
  )
  const cargo = placed.flatMap(({ item, placement }) =>
    placement?.kind === 'cargo' ? [{ typeId: item.type_id, quantity: item.quantity }] : []
  )

  return {
    name: esiFit.name,
    shipTypeId: esiFit.ship_type_id,
    modules: attachCharges(modules, charges),
    drones: accumulate(drones, (into, from) => {
      into.active += from.active
      into.passive += from.passive
    }),
    cargo: accumulate(cargo, (into, from) => {
      into.quantity += from.quantity
    }),
  }
}

export type DogmaFit = {
  ship_type_id: number
  modules: { type_id: number; slot: Slot; state: string; charge?: { type_id: number } }[]
  drones: { type_id: number; state: string }[]
}

// The engine takes one entry per drone rather than a count, and every module
// online-and-running: we render a ship as it sits, and nothing in this view
// can offline a module or change its state.
export const esfFitToDogmaFit = (fit: EsfFit): DogmaFit => ({
  ship_type_id: fit.shipTypeId,
  modules: fit.modules.map((module) => ({
    type_id: module.typeId,
    slot: module.slot,
    state: 'Active',
    charge: module.charge === undefined ? undefined : { type_id: module.charge.typeId },
  })),
  drones: fit.drones.flatMap((drone) => [
    ...Array.from({ length: drone.active }, () => ({ type_id: drone.typeId, state: 'Active' })),
    ...Array.from({ length: drone.passive }, () => ({ type_id: drone.typeId, state: 'Passive' })),
  ]),
})
