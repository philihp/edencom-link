import type { SdeType } from '@/sdeTypes'

import { toEft, type EftType } from '../../fitting/eft.ts'
import type { FittingItem } from '../../fitting/fit'

// The ship as EFT text — what the in-game fitting window reads back through
// "Import from clipboard", so a hull in a hangar can be reproduced as a saved
// fit. The notation itself lives in src/app/fitting/eft.ts and is shared with
// the fitting pages; this is only the adapter from a ship's asset rows to the
// fitting record that writer reads.
//
// Pure: the caller resolves the type names and categories (SDE) and hands
// them in, the same way the fitting page does.

export type EftRow = {
  typeId: number
  // The location flag ESI reports for the row: a slot ("HiSlot0"), a bay
  // ("DroneBay", "Cargo") or null for a row the hangar view can't place.
  flag: string | null
  quantity: number | string | null
}

// A row with no flag sits in no slot and no bay, so there is no block to write
// it into; it is dropped rather than guessed at.
const toFittingItem = (row: EftRow): FittingItem[] =>
  row.flag === null ? [] : [{ type_id: row.typeId, flag: row.flag, quantity: Number(row.quantity ?? 1) }]

// The SDE lookup, trimmed to the two fields the writer needs: the name it
// prints, and the category that tells a loaded charge from its module.
export const eftTypes = (sdeTypes: Record<number, SdeType>): Record<number, EftType> =>
  Object.fromEntries(
    Object.values(sdeTypes).map((type) => [type.typeID, { name: type.name, categoryID: type.categoryID }])
  )

// The whole ship as EFT text. A hull's own name (the one its pilot gave it)
// becomes the fit's title; an unnamed hull falls back to its type, as toEft
// already does for a fitting saved without a name.
export const shipEft = (
  shipTypeId: number,
  shipName: string | null,
  rows: EftRow[],
  types: Record<number, EftType>
): string => toEft({ name: shipName, ship_type_id: shipTypeId, items: rows.flatMap(toFittingItem) }, types)
