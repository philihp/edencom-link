import type { EsiFit } from '@eveshipfit/react'

// One saved fitting as it comes out of the character_fitting view. `items` is
// the jsonb blob the extract job normalized and slot-sorted (see
// src/jobs/characterFittings.js).
export type FittingItem = {
  type_id: number
  flag: string
  quantity: number
}

export type FittingRow = {
  registration_id: string
  fitting_id: number | string
  name: string | null
  description: string | null
  ship_type_id: number | string
  items: FittingItem[] | null
}

// The one URL every fitting lives at, whether the viewer owns it or sees it
// through a character_fitting_share row. fitting_id is only unique per
// character (ESI numbers them from 1 per pilot), so the route carries the
// owner too rather than pretending the id is global.
//
// The owner is identified by their EVE numeric character id — not the
// registration uuid the tables key on, which is an internal surrogate. The
// two are translated at the route boundary by resolveCharacter.ts.
export const fittingRoute = (characterId: number | string, fittingId: number | string): string =>
  `/fitting/${characterId}/${fittingId}`

// Shapes a stored fitting into the ESI-fitting-JSON shape @eveshipfit/react's
// useImportEsiFitting() hook expects — nearly a pass-through, since the table
// stores ESI's own field names.
//
// The one difference: ESI's *fitting* items carry no item_id (unlike the
// hangar-asset rows /ship/[itemId] feeds through the same hook), while the
// viewer's EsiFit type requires one. The array index stands in. It's only an
// identity key for the viewer's own slot bookkeeping — it never leaves the
// browser and is never persisted.
export const toEsiFit = (row: Pick<FittingRow, 'name' | 'description' | 'ship_type_id' | 'items'>): EsiFit => ({
  name: row.name ?? '',
  description: row.description ?? '',
  ship_type_id: Number(row.ship_type_id),
  items: (row.items ?? []).map((item, index) => ({
    item_id: index,
    type_id: Number(item.type_id),
    flag: item.flag ?? '',
    quantity: Number(item.quantity ?? 1),
  })),
})

// Slot flags in the order the fitting window shows them, so a module list reads
// top-to-bottom the way the ship does. Anything unrecognized (a new bay flag)
// sorts last but still renders, rather than being dropped.
const FLAG_ORDER = [
  'HiSlot',
  'MedSlot',
  'LoSlot',
  'RigSlot',
  'SubSystemSlot',
  'ServiceSlot',
  'DroneBay',
  'FighterBay',
  'Cargo',
]

// Human label for a group of same-prefix flags (HiSlot0..7 → "High slots").
const FLAG_GROUPS: Array<{ prefix: string; label: string }> = [
  { prefix: 'HiSlot', label: 'High slots' },
  { prefix: 'MedSlot', label: 'Mid slots' },
  { prefix: 'LoSlot', label: 'Low slots' },
  { prefix: 'RigSlot', label: 'Rigs' },
  { prefix: 'SubSystemSlot', label: 'Subsystems' },
  { prefix: 'ServiceSlot', label: 'Services' },
  { prefix: 'DroneBay', label: 'Drone bay' },
  { prefix: 'FighterBay', label: 'Fighter bay' },
  { prefix: 'Cargo', label: 'Cargo' },
]

// Which FLAG_GROUPS entry a flag belongs to, by longest-matching prefix. Order
// matters only for display, so an unknown flag lands in a trailing "Other" group.
export const groupForFlag = (flag: string): string =>
  FLAG_GROUPS.find(({ prefix }) => flag.startsWith(prefix))?.label ?? 'Other'

export const flagSortKey = (flag: string): number => {
  const index = FLAG_ORDER.findIndex((prefix) => flag.startsWith(prefix))
  return index === -1 ? FLAG_ORDER.length : index
}
