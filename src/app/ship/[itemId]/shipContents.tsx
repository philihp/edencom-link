import type { SupabaseClient } from '@supabase/supabase-js'

import { getSdeTypes } from '@/sdeTypes'
import { LocationAssets, type ItemRow } from '../../asset/[locationId]/locationAssets'
import { typeFacts } from '../../assetTypeFacts'
import { fetchOwners } from '../../owners'
import type { Owners } from '../../ownerFilter'
import { fetchTypeNames } from '../../typeNames'
import { SHIP_CATEGORY_ID, fittingOrder, hullRow, nestedCount, type ChildRow, type Hull } from './shipRows'

// Everything the ship holds, as the sortable table the asset browser uses, in
// its own async server component so the page can stream it.
//
// The viewer above draws what is fitted and what is aboard, but its bay cards
// link nowhere; this table is the only way into a container nested inside a
// ship (a can inside a fleet hangar), and the only place a ship's contents can
// be sorted, filtered by owner, or selected for appraisal. That is why it
// survived the swap to the new viewer (docs/custom-fit-ui.md, stage 4 phase 2).
//
// The child rows come from the page — it already reads them for the viewer, so
// asking for them twice would buy nothing. What is left here is what costs: a
// subtree walk for the nested counts, plus the owner list the table's filter
// needs. Splitting those off lets the ship draw itself immediately and fill in
// its contents when they arrive.
export const ShipContents = async ({
  supabase,
  itemId,
  self,
  ownerId,
  childRows,
}: {
  supabase: SupabaseClient
  itemId: string
  self: Hull
  ownerId: string
  childRows: ChildRow[]
}) => {
  const [characterContents, corpContents, owners] = await Promise.all([
    // Nested-contents counts drive the drill-in links on container/ship rows.
    supabase.rpc('character_asset_location_contents', { parent: itemId }),
    supabase.rpc('corp_asset_location_contents', { parent: itemId }),
    fetchOwners(),
  ])

  const contentsByItem = new Map<string, number>(
    (
      [...(characterContents.data ?? []), ...(corpContents.data ?? [])] as {
        item_id: number | string
        contents: number | string
      }[]
    ).map((r) => [String(r.item_id), Number(r.contents)])
  )

  // One bulk SDE lookup → set of Ship-category type ids among the cargo, so the
  // per-row drill-in link test stays a sync Set.has. The hull's own type rides
  // along for its row's volume/group/category columns. Already resolved by the
  // page's own lookup, so this is a process-cache hit.
  const childTypes = await getSdeTypes([Number(self.type_id), ...childRows.map((c) => Number(c.type_id))])
  const childShipTypeIds = new Set(
    Object.values(childTypes)
      .filter((t) => t.categoryID === SHIP_CATEGORY_ID)
      .map((t) => t.typeID)
  )

  const typeNamesPromise = fetchTypeNames([Number(self.type_id), ...childRows.map((c) => Number(c.type_id))])
  const rows: ItemRow[] = fittingOrder(
    childRows.map((c) => {
      const contents = contentsByItem.get(String(c.item_id)) ?? 0
      return {
        itemId: String(c.item_id),
        ownerId: c.registration_id ?? String(c.corporation_id),
        typeId: Number(c.type_id),
        name: c.name ?? null,
        quantity: c.quantity,
        isSingleton: c.is_singleton,
        flag: c.location_flag,
        contents,
        isCurrentShip: false,
        href: childShipTypeIds.has(Number(c.type_id))
          ? `/ship/${c.item_id}`
          : contents > 0
            ? `/asset/${c.item_id}`
            : null,
        ...typeFacts(childTypes[Number(c.type_id)], c.is_blueprint_copy),
      }
    })
  )

  // The hull heads the table: "everything shown in this list" has to include
  // the thing the page is about, since the list is what gets appraised.
  const tableRows: ItemRow[] = [
    hullRow(self, ownerId, childTypes[Number(self.type_id)], nestedCount(childRows, contentsByItem)),
    ...rows,
  ]

  return <LocationAssets rows={tableRows} owners={owners} typeNamesPromise={typeNamesPromise} canAppraise />
}

// The same table on the anonymous share path, where three things are missing
// by design: the drill-down (a nested container would need a share token of
// its own to open), the nested-contents counts (the walk RPCs are skipped, so
// it reports none rather than a guess), and appraisal. Its rows come from the
// caller, which has already scoped every query to the sharer.
export const SharedShipContents = async ({
  self,
  owner,
  childRows,
}: {
  self: Hull
  // Who the whole subtree belongs to: everything inside a ship belongs to
  // whoever owns the ship, so one owner covers the table.
  owner: { id: string; name: string; kind: 'character' | 'corporation' }
  childRows: ChildRow[]
}) => {
  const typeIds = [Number(self.type_id), ...childRows.map((c) => Number(c.type_id))]
  // Pure SDE data — public-read, nothing owner-specific — so it's as safe on
  // the share path as the type names are.
  const typeNamesPromise = fetchTypeNames(typeIds)
  const childTypes = await getSdeTypes(typeIds)

  const rows: ItemRow[] = fittingOrder(
    childRows.map((c) => ({
      itemId: String(c.item_id),
      ownerId: owner.id,
      typeId: Number(c.type_id),
      name: c.name ?? null,
      quantity: c.quantity,
      isSingleton: c.is_singleton,
      flag: c.location_flag,
      contents: 0,
      isCurrentShip: false,
      href: null,
      ...typeFacts(childTypes[Number(c.type_id)], c.is_blueprint_copy),
    }))
  )

  // The table's owner column/filter only ever sees the sharing owner — the
  // anonymous viewer has no owner context of their own to offer.
  const owners: Owners =
    owner.kind === 'character'
      ? { characters: [{ id: owner.id, name: owner.name }], corporations: [] }
      : { characters: [], corporations: [{ id: owner.id, name: owner.name }] }

  return (
    <LocationAssets
      // Hull first here too, so a shared ship lists the same things the
      // owner's own view does.
      rows={[hullRow(self, owner.id, childTypes[Number(self.type_id)], 0), ...rows]}
      owners={owners}
      typeNamesPromise={typeNamesPromise}
      canAppraise={false}
    />
  )
}
