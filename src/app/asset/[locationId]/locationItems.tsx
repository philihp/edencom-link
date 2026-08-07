import type { SupabaseClient } from '@supabase/supabase-js'

import { getSdeTypes } from '@/sdeTypes'
import { typeFacts } from '../../assetTypeFacts'
import type { Owners } from '../../ownerFilter'
import { fetchTypeNames } from '../../typeNames'
import { SHIP_CATEGORY_ID, type Asset } from './locationData'
import { LocationAssets, type ItemRow } from './locationAssets'

// The item table, as its own async server component so the page can stream it.
//
// This is where the slow half of the page lives: counting what each container
// holds means walking its whole subtree in Postgres, which is far and away the
// most expensive query the route runs. The heading and breadcrumb above it need
// none of that, so they flush first and this arrives when it's ready.
export const LocationItems = async ({
  supabase,
  locationId,
  rootItems,
  currentShipItemIds,
  owners,
  // False on the anonymous share-token path. It turns off three things at once:
  // the contents counts (those functions walk every asset unscoped when run as
  // service_role), the drill-down links they feed (a nested level would need
  // its own token), and the appraisal controls (no session to authorize with).
  linkable,
}: {
  supabase: SupabaseClient
  locationId: string
  rootItems: Asset[]
  currentShipItemIds: Set<string>
  owners: Owners
  linkable: boolean
}) => {
  // Total items held inside each ship/container at this location, counted across
  // the whole subtree by the *_asset_location_contents() functions in Postgres.
  // An item lives in exactly one of the two tables, so the maps can't collide.
  const contentsByItem = new Map<string, number>()
  if (linkable) {
    const [{ data: characterContents }, { data: corpContents }] = await Promise.all([
      supabase.rpc('character_asset_location_contents', { parent: locationId }),
      supabase.rpc('corp_asset_location_contents', { parent: locationId }),
    ])
    for (const r of [...(characterContents ?? []), ...(corpContents ?? [])] as {
      item_id: number | string
      contents: number | string
    }[]) {
      contentsByItem.set(String(r.item_id), Number(r.contents))
    }
  }

  // One bulk SDE lookup for every type in play. It feeds three things: the set
  // of Ship-category type ids, so the per-row ship test stays a sync Set.has;
  // each row's volume/group/category columns; and which image variation its
  // icon has.
  const itemTypes = await getSdeTypes(rootItems.map((a) => Number(a.type_id)))
  const shipTypeIds = new Set(
    Object.values(itemTypes)
      .filter((t) => t.categoryID === SHIP_CATEGORY_ID)
      .map((t) => t.typeID)
  )
  const isShip = (typeId: number | string) => shipTypeIds.has(Number(typeId))

  // Resolve type names without blocking render: fire the lookup and let each
  // TypeName stream in (Suspense), falling back to #id. A big hangar can hold
  // hundreds of distinct types, and awaiting them all here times the page out.
  const typeNamesPromise = fetchTypeNames(rootItems.map((a) => Number(a.type_id)))

  // Containers/ships (those holding items) first, then a stable id order.
  const rows: ItemRow[] = rootItems
    .map((a) => {
      const contents = contentsByItem.get(String(a.item_id)) ?? 0
      const type = itemTypes[Number(a.type_id)]
      return {
        itemId: String(a.item_id),
        ownerId: a.owner_id,
        typeId: Number(a.type_id),
        name: a.name,
        quantity: a.quantity,
        isSingleton: a.is_singleton,
        flag: a.location_flag,
        contents,
        isCurrentShip: currentShipItemIds.has(String(a.item_id)),
        href: !linkable ? null : isShip(a.type_id) ? `/ship/${a.item_id}` : contents > 0 ? `/asset/${a.item_id}` : null,
        ...typeFacts(type, a.is_blueprint_copy),
      }
    })
    .sort((a, b) => b.contents - a.contents || a.typeId - b.typeId)

  return <LocationAssets rows={rows} owners={owners} typeNamesPromise={typeNamesPromise} canAppraise={linkable} />
}
