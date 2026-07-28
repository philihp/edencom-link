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
  character_id: string
  fitting_id: number | string
  name: string | null
  description: string | null
  ship_type_id: number | string
  items: FittingItem[] | null
}

// Shapes a stored fitting into the ESI-fitting-JSON shape @eveshipfit/react's
// useImportEsiFitting() hook expects — nearly a pass-through, since the tables
// (character_fitting and shared_fitting alike) store ESI's own field names.
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

// Every fitting on the site — personal or published — lives at one URL shape,
// /fitting/[fittingId], so a link never has to know which kind it's pointing
// at. The two sources don't share an id space, though: a shared_fitting row
// has a globally unique uuid, but ESI numbers personal fittings per pilot (a
// bigint that's only unique *within* one character — every character has a
// fitting 1), so a bare fitting_id can't address one on its own.
//
// The route param is therefore an opaque token: a shared fit's id verbatim
// (already a uuid), or `${characterId}_${fittingId}` for a personal one.
// `_` never appears in a uuid's canonical hex-and-hyphen form or in a numeric
// fitting_id, so splitting on the last `_` is unambiguous — a param with no
// `_` is a shared uuid, one with an `_` is a personal fit's composite id.
export const personalFittingRoute = (characterId: string, fittingId: number | string): string =>
  `/fitting/${characterId}_${fittingId}`

export const sharedFittingRoute = (sharedId: string): string => `/fitting/${sharedId}`

export type FittingRouteParam =
  { kind: 'personal'; characterId: string; fittingId: string } | { kind: 'shared'; sharedId: string }

export const parseFittingRouteParam = (param: string): FittingRouteParam | null => {
  const at = param.lastIndexOf('_')
  if (at === -1) return { kind: 'shared', sharedId: param }
  const characterId = param.slice(0, at)
  const fittingId = param.slice(at + 1)
  if (!characterId || !/^\d+$/.test(fittingId)) return null
  return { kind: 'personal', characterId, fittingId }
}
