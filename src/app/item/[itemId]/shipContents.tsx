import type { SupabaseClient } from '@supabase/supabase-js'
import { getSdeTypes } from '@/sdeTypes'
import { typeFacts } from '../../assetTypeFacts'
import { LocationAssets, type ItemRow } from '../../asset/[locationId]/locationAssets'
import { fetchOwners } from '../../owners'
import { fetchTypeNames } from '../../typeNames'
import { toEsiFit } from '../../ship/[itemId]/esfFit'
import { ShipFitViewDynamic } from './shipFitViewDynamic'
import {
  SHIP_CATEGORY_ID,
  fittingOrder,
  hullRow,
  nestedCount,
  type ChildRow,
  type Hull,
} from '../../ship/[itemId]/shipRows'

// The fit wheel and the module/cargo table, as their own async server component
// so the page can stream them.
//
// What's above them — the ship's name, owner and breadcrumb — needs none of
// this, and this is the part that costs: a subtree walk for the nested counts
// on top of the child query. Splitting them lets the page identify the ship
// immediately and fill in its contents when they arrive. (The wheel then has a
// second, client-side wait of its own for the WASM chunk and protobufs, which
// FitPlaceholder covers.)
export const ShipContents = async ({
  supabase,
  itemId,
  self,
  ownerId,
}: {
  supabase: SupabaseClient
  itemId: string
  self: Hull
  ownerId: string
}) => {
  const [{ data: characterChildren }, { data: corpChildren }, characterContents, corpContents, owners] =
    await Promise.all([
      supabase
        .from('character_asset')
        .select('item_id, registration_id, type_id, location_flag, quantity, is_singleton, is_blueprint_copy, name')
        .eq('location_id', itemId),
      supabase
        .from('corp_asset')
        .select('item_id, corporation_id, type_id, location_flag, quantity, is_singleton, is_blueprint_copy')
        .eq('location_id', itemId),
      // Nested-contents counts drive the drill-in links on container/ship rows.
      supabase.rpc('character_asset_location_contents', { parent: itemId }),
      supabase.rpc('corp_asset_location_contents', { parent: itemId }),
      fetchOwners(),
    ])

  const children = [...((characterChildren ?? []) as ChildRow[]), ...((corpChildren ?? []) as ChildRow[])]
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
  // along for its row's volume/group/category columns.
  const childTypes = await getSdeTypes([Number(self.type_id), ...children.map((c) => Number(c.type_id))])
  const childShipTypeIds = new Set(
    Object.values(childTypes)
      .filter((t) => t.categoryID === SHIP_CATEGORY_ID)
      .map((t) => t.typeID)
  )

  const typeNamesPromise = fetchTypeNames([Number(self.type_id), ...children.map((c) => Number(c.type_id))])
  const rows: ItemRow[] = fittingOrder(
    children.map((c) => {
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

  // The hull heads the table; the fit viewer below is fed the children alone,
  // since a ship isn't a module fitted to itself.
  const tableRows: ItemRow[] = [
    hullRow(self, ownerId, childTypes[Number(self.type_id)], nestedCount(children, contentsByItem)),
    ...rows,
  ]

  return (
    <>
      <ShipFitViewDynamic esiFit={toEsiFit(Number(self.type_id), self.name ?? null, rows)} />
      <LocationAssets rows={tableRows} owners={owners} typeNamesPromise={typeNamesPromise} canAppraise />
    </>
  )
}
