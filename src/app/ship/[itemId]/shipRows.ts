import { ascend, sortWith } from 'ramda'

import { type SdeType } from '@/sdeTypes'
import { typeFacts } from '../../assetTypeFacts'
import { type ItemRow } from '../../asset/[locationId]/locationAssets'
import { flagSortKey } from '../../fitting/fit'

// The row-shaping the ship page shares with the contents section it streams,
// and with the anonymous share-link view. In its own module so those can't end
// up importing each other.

// invGroups.categoryID for the Ship category in CCP's SDE.
export const SHIP_CATEGORY_ID = 6

export type ChildRow = {
  item_id: number | string
  type_id: number | string
  location_flag: string | null
  quantity: number | string | null
  is_singleton: boolean | null
  is_blueprint_copy?: boolean | null
  name?: string | null
  registration_id?: string
  corporation_id?: number | string
}

// The hull itself, as far as the row-building needs to know it.
export type Hull = { item_id: number | string; type_id: number | string; name?: string | null }

// Fitting-window order for the module table: slot family first (high → mid →
// low → rigs → bays, via the same flagSortKey the fitting pages use), the flag
// string within a family (HiSlot0 before HiSlot1), then type id. This is the
// server order the unsorted table shows, so the listing reads top-to-bottom
// the way the ship does.
export const fittingOrder = sortWith<ItemRow>([
  ascend((r) => flagSortKey(r.flag ?? '')),
  ascend((r) => r.flag ?? ''),
  ascend((r) => r.typeId),
])

// The hull as a row of its own, heading the module table.
//
// It isn't one of the ship's children — it's their container — so nothing in
// the child query produces it, and the table used to list a ship's contents
// without listing the ship. That reads as an omission now that the table is
// what gets selected and appraised: "everything shown in this list" has to
// include the thing the page is about. Assembled, hence a singleton with no
// stack size, and it links nowhere: this is already its page.
export const hullRow = (self: Hull, ownerId: string, type: SdeType | undefined, contents: number): ItemRow => ({
  itemId: String(self.item_id),
  ownerId,
  typeId: Number(self.type_id),
  name: self.name ?? null,
  quantity: null,
  isSingleton: true,
  flag: null,
  contents,
  isCurrentShip: false,
  href: null,
  ...typeFacts(type),
})

// How many items the hull holds, all the way down: its own children plus
// whatever each of them contains. The per-child counts come from the same
// *_location_contents() walk the drill-in links use, so the hull's Contents
// cell agrees with the rows under it.
export const nestedCount = (children: ChildRow[], contentsByItem: Map<string, number>): number =>
  children.length + children.reduce((total, c) => total + (contentsByItem.get(String(c.item_id)) ?? 0), 0)
