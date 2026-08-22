import type { EsfModule, SlotType } from './esf/fit'
import type { SlotCounts } from './esf/attributes'

// What the two list panels beside and below the ring show, as pure folds over
// the fit: the slot listing (stage 3) and the bay listing ("aboard right now").
// No React, no engine — the component hands these the fit and the hull's
// capacities and renders what comes back.

export type ModuleGroup = {
  typeId: number
  chargeTypeId: number | null
  // Identical modules in one family collapse into a stack, as the fitting
  // window shows them: five launchers loaded the same way are one line.
  count: number
}

export type SlotSection = {
  family: SlotType
  label: string
  fitted: number
  total: number
  groups: ModuleGroup[]
}

const SLOT_LABELS: [SlotType, string][] = [
  ['High', 'High slots'],
  ['Medium', 'Mid slots'],
  ['Low', 'Low slots'],
  ['Rig', 'Rigs'],
  ['SubSystem', 'Subsystems'],
]

// Modules of one family, in slot order, with runs of the same module (and the
// same loaded charge) collapsed. A different charge splits the stack: two
// launchers loaded with different ammunition are two lines, because they are
// two different things to buy and two different damage profiles.
const collapse = (modules: EsfModule[]): ModuleGroup[] =>
  modules.reduce<ModuleGroup[]>((groups, module) => {
    const chargeTypeId = module.charge?.typeId ?? null
    const existing = groups.find((group) => group.typeId === module.typeId && group.chargeTypeId === chargeTypeId)
    if (existing) existing.count += 1
    else groups.push({ typeId: module.typeId, chargeTypeId, count: 1 })
    return groups
  }, [])

// A family the hull doesn't have and nothing is fitted to is dropped — most
// hulls have no subsystems, and an empty "Subsystems 0/0" heading is noise.
export const slotSections = (modules: EsfModule[], counts: SlotCounts): SlotSection[] =>
  SLOT_LABELS.flatMap(([family, label]) => {
    const own = modules.filter((module) => module.slot.type === family)
    const total = counts[family]
    if (total === 0 && own.length === 0) return []
    return [{ family, label, fitted: own.length, total, groups: collapse(own) }]
  })

export type BayItem = { typeId: number; quantity: number; volume: number | null }

export type Bay = {
  flag: string
  label: string
  // m³ the hull holds, from the matching dogma attribute; null when the bay is
  // one we have no capacity attribute for, in which case the fill bar is left off
  // rather than drawn against an invented cap.
  capacity: number | null
  // m³ aboard. Null only when a type in it has no volume in the SDE mirror,
  // which would make the sum a lie rather than a total.
  used: number | null
  items: BayItem[]
}

// The bays a ship can carry things in, in the order the fitting window lists
// them, each with the hull attribute holding its capacity. A bay is shown when
// the hull has one, whether or not anything is in it: "fleet hangar, empty" is
// information, and it's the answer to "can I put this in here".
const BAY_DEFINITIONS: [string, string, string][] = [
  ['Cargo', 'Cargo hold', 'capacity'],
  ['DroneBay', 'Drone bay', 'droneCapacity'],
  ['FighterBay', 'Fighter bay', 'fighterCapacity'],
  ['ShipHangar', 'Ship maintenance bay', 'shipMaintenanceBayCapacity'],
  ['FleetHangar', 'Fleet hangar', 'fleetHangarCapacity'],
  ['SpecializedFuelBay', 'Fuel bay', 'specialFuelBayCapacity'],
  ['SpecializedOreHold', 'Ore hold', 'specialOreHoldCapacity'],
  ['SpecializedGasHold', 'Gas hold', 'specialGasHoldCapacity'],
  ['SpecializedMineralHold', 'Mineral hold', 'specialMineralHoldCapacity'],
  ['SpecializedSalvageHold', 'Salvage hold', 'specialSalvageHoldCapacity'],
  ['SpecializedAmmoHold', 'Ammo hold', 'specialAmmoHoldCapacity'],
  ['SpecializedCommandCenterHold', 'Command center hold', 'specialCommandCenterHoldCapacity'],
  ['SpecializedPlanetaryCommoditiesHold', 'Planetary commodities hold', 'specialPlanetaryCommoditiesHoldCapacity'],
  ['SpecializedMaterialBay', 'Material bay', 'specialMaterialBayCapacity'],
  ['SpecializedIndustrialShipHold', 'Industrial ship hold', 'specialIndustrialShipHoldCapacity'],
  ['SpecializedAsteroidHold', 'Asteroid hold', 'specialAsteroidHoldCapacity'],
  ['SpecializedIceHold', 'Ice hold', 'specialIceHoldCapacity'],
]

// A flag we have no definition for still gets a bay rather than vanishing —
// CCP adds holds faster than anyone updates a table, and an unnamed bay full
// of things beats a ship that appears to be carrying nothing. `QuafeBay` reads
// as "Quafe bay".
const humanizeFlag = (flag: string): string => {
  const words = flag.replace(/^Specialized/, '').replace(/([a-z])([A-Z])/g, '$1 $2')
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase()
}

// The bay's contents as m³, or null when a type in it has no volume in the
// SDE mirror — a total that silently skipped a line would be a lie.
const usedVolume = (items: BayItem[]): number | null =>
  items.reduce<number | null>(
    (total, item) => (total === null || item.volume === null ? null : total + item.volume * item.quantity),
    0
  )

export type BayRow = { typeId: number; flag: string; quantity: number }

// Anything carried rather than fitted, grouped into the hull's bays. Charges
// loaded into a weapon carry their *slot's* flag (see esf/fit.ts), so they
// never reach this: they're already drawn in the slot they're loaded into.
export const groupBays = (
  rows: BayRow[],
  volumeOf: (typeId: number) => number | undefined,
  capacityOf: (attribute: string) => number
): Bay[] => {
  const byFlag = rows.reduce<Map<string, BayItem[]>>((map, row) => {
    const items = map.get(row.flag) ?? []
    const existing = items.find((item) => item.typeId === row.typeId)
    const volume = volumeOf(row.typeId)
    if (existing) existing.quantity += row.quantity
    else items.push({ typeId: row.typeId, quantity: row.quantity, volume: volume ?? null })
    map.set(row.flag, items)
    return map
  }, new Map())

  const known = BAY_DEFINITIONS.flatMap<Bay>(([flag, label, attribute]) => {
    const items = byFlag.get(flag) ?? []
    const capacity = capacityOf(attribute)
    if (capacity <= 0 && items.length === 0) return []
    return [{ flag, label, capacity, used: usedVolume(items), items }]
  })

  const named = new Set(BAY_DEFINITIONS.map(([flag]) => flag))
  const unknown = [...byFlag.keys()]
    .filter((flag) => !named.has(flag))
    .map<Bay>((flag) => {
      const items = byFlag.get(flag) ?? []
      return { flag, label: humanizeFlag(flag), capacity: null, used: usedVolume(items), items }
    })

  return [...known, ...unknown]
}
