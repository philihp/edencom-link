import { notFound, redirect } from 'next/navigation'

import { getSdeType, getSdeTypes } from '@/sdeTypes'
import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { AssetPath, fetchAssetPath } from '../../assetPath'
import { fetchTypeNames } from '../../typeNames'
import { type ItemRow } from '../../asset/[locationId]/locationAssets'
import { resolveShareToken } from '../access'
import { toEsiFit } from './esfFit'
import { ShareControls } from './shareControls'
import { ShipCargo } from './shipCargo'
import { ShipFitViewDynamic } from './shipFitViewDynamic'

// invGroups.categoryID for the Ship category in CCP's SDE.
const SHIP_CATEGORY_ID = 6

type ShipRow = {
  item_id: number | string
  type_id: number | string
  location_id: number | string | null
  location_type: string | null
  name: string | null
  character_id?: string
  corporation_id?: number | string
}

type ChildRow = {
  item_id: number | string
  type_id: number | string
  location_flag: string | null
  quantity: number | string | null
  is_singleton: boolean | null
  name?: string | null
  character_id?: string
  corporation_id?: number | string
}

// Whether a single type is in the Ship category — one SDE lookup, for the
// self-type gate that decides ship page vs asset browser.
const isShipType = async (typeId: number | string): Promise<boolean> =>
  (await getSdeType(Number(typeId)))?.categoryID === SHIP_CATEGORY_ID

// A ship's own page: the eveship.fit wheel + stats built from its fitted
// modules, its cargo bays, owner and location. Reachable authenticated (RLS
// scopes everything to the caller), or anonymously with a valid share token —
// the token path uses the service-role client, so every query there is
// explicitly filtered to the sharing user's characters/corps, and location is
// deliberately omitted (a share link shouldn't broadcast where the ship is).
const ShipPage = async ({
  params,
  searchParams,
}: {
  params: Promise<{ itemId: string }>
  searchParams: Promise<{ token?: string }>
}) => {
  const { itemId } = await params
  const { token } = await searchParams

  if (token) return <SharedShipPage itemId={itemId} token={token} />

  const supabase = await createClient()
  const { data: auth, error: authError } = await supabase.auth.getUser()
  if (authError || !auth?.user) {
    redirect('/')
  }

  // The ship row, from whichever hangar owns it.
  const { data: characterSelf } = await supabase
    .from('character_asset')
    .select('item_id, character_id, type_id, location_id, location_type, name')
    .eq('item_id', itemId)
    .maybeSingle<ShipRow>()
  const { data: corpSelf } = characterSelf
    ? { data: null }
    : await supabase
        .from('corp_asset')
        .select('item_id, corporation_id, type_id, location_id, location_type')
        .eq('item_id', itemId)
        .maybeSingle<ShipRow>()
  const self = characterSelf ?? corpSelf
  if (!self) notFound()
  // Non-ships (containers, loose stacks) live on the asset browser instead.
  if (!(await isShipType(self.type_id))) redirect(`/asset/${itemId}`)

  const [{ data: characterChildren }, { data: corpChildren }] = await Promise.all([
    supabase
      .from('character_asset')
      .select('item_id, character_id, type_id, location_flag, quantity, is_singleton, name')
      .eq('location_id', itemId),
    supabase
      .from('corp_asset')
      .select('item_id, corporation_id, type_id, location_flag, quantity, is_singleton')
      .eq('location_id', itemId),
  ])
  const children = [...((characterChildren ?? []) as ChildRow[]), ...((corpChildren ?? []) as ChildRow[])]

  // Nested-contents counts drive the drill-in links on cargo tiles.
  const [{ data: characterContents }, { data: corpContents }] = await Promise.all([
    supabase.rpc('character_asset_location_contents', { parent: itemId }),
    supabase.rpc('corp_asset_location_contents', { parent: itemId }),
  ])
  const contentsByItem = new Map<string, number>(
    (
      [...(characterContents ?? []), ...(corpContents ?? [])] as {
        item_id: number | string
        contents: number | string
      }[]
    ).map((r) => [String(r.item_id), Number(r.contents)])
  )

  // Owner: the holding character's name, or the corporation's cached name.
  let ownerName: string
  if (characterSelf?.character_id) {
    const { data: registration } = await supabase
      .from('registration')
      .select('name')
      .eq('id', characterSelf.character_id)
      .maybeSingle<{ name: string }>()
    ownerName = registration?.name ?? 'Unknown character'
  } else {
    const corporationId = Number(corpSelf?.corporation_id)
    const { data: corpName } = await supabase
      .from('universe_name')
      .select('name')
      .eq('id', corporationId)
      .maybeSingle<{ name: string }>()
    ownerName = corpName?.name ?? `Corporation #${corporationId}`
  }

  // Where the ship lives: the full container chain up to its station /
  // structure / system, rendered as the breadcrumb above the heading.
  const crumbs = await fetchAssetPath(itemId, supabase)

  const typeNames = await fetchTypeNames([Number(self.type_id)])
  const typeName = typeNames[Number(self.type_id)] ?? `#${self.type_id}`
  const heading = self.name && self.name !== typeName ? `${self.name} (${typeName})` : typeName

  // One bulk SDE lookup → set of Ship-category type ids among the cargo, so the
  // per-row drill-in link test stays a sync Set.has.
  const childTypes = await getSdeTypes(children.map((c) => Number(c.type_id)))
  const childShipTypeIds = new Set(
    Object.values(childTypes)
      .filter((t) => t.categoryID === SHIP_CATEGORY_ID)
      .map((t) => t.typeID)
  )

  const typeNamesPromise = fetchTypeNames(children.map((c) => Number(c.type_id)))
  const rows: ItemRow[] = children
    .map((c) => {
      const contents = contentsByItem.get(String(c.item_id)) ?? 0
      return {
        itemId: String(c.item_id),
        ownerId: c.character_id ?? String(c.corporation_id),
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
      }
    })
    .sort((a, b) => b.contents - a.contents || a.typeId - b.typeId)

  const { data: share } = await supabase
    .from('shared_asset_token')
    .select('token')
    .eq('item_id', itemId)
    .maybeSingle<{ token: string }>()

  return (
    <>
      <AssetPath crumbs={crumbs} current={heading} />
      <h1 className="serif">{heading}</h1>
      <p>
        Owner: <span className="serif">{ownerName}</span>
      </p>
      <ShareControls itemId={itemId} initialToken={share?.token ?? null} />
      <ShipFitViewDynamic esiFit={toEsiFit(Number(self.type_id), self.name ?? null, rows)} />
      <ShipCargo rows={rows} typeNamesPromise={typeNamesPromise} />
    </>
  )
}

// Anonymous share-token view: wheel + name + owner only. All queries run on
// the service client, explicitly filtered to the sharer's characters/corps.
const SharedShipPage = async ({ itemId, token }: { itemId: string; token: string }) => {
  const scope = await resolveShareToken(token, itemId)
  if (!scope) notFound()

  const supabase = createServiceClient()
  const { data: characterSelf } = await supabase
    .from('character_asset')
    .select('item_id, character_id, type_id, name')
    .eq('item_id', itemId)
    .in('character_id', scope.characterIds)
    .maybeSingle<ShipRow>()
  const { data: corpSelf } = characterSelf
    ? { data: null }
    : await supabase
        .from('corp_asset')
        .select('item_id, corporation_id, type_id')
        .eq('item_id', itemId)
        .in('corporation_id', scope.corporationIds.length > 0 ? scope.corporationIds : [-1])
        .maybeSingle<ShipRow>()
  const self = characterSelf ?? corpSelf
  // The share outlived the ship (sold, transferred, unlinked): dead link.
  if (!self || !(await isShipType(self.type_id))) notFound()

  const [{ data: characterChildren }, { data: corpChildren }] = await Promise.all([
    supabase
      .from('character_asset')
      .select('item_id, type_id, location_flag, quantity, is_singleton, name')
      .eq('location_id', itemId)
      .in('character_id', scope.characterIds),
    supabase
      .from('corp_asset')
      .select('item_id, type_id, location_flag, quantity, is_singleton')
      .eq('location_id', itemId)
      .in('corporation_id', scope.corporationIds.length > 0 ? scope.corporationIds : [-1]),
  ])
  const children = [...((characterChildren ?? []) as ChildRow[]), ...((corpChildren ?? []) as ChildRow[])]

  // Everything inside a ship belongs to whoever owns the ship, so the whole
  // cargo view carries a single owner.
  const ownerId = characterSelf?.character_id ?? String(corpSelf?.corporation_id)
  let ownerName: string
  if (characterSelf?.character_id) {
    ownerName = scope.characterNames.get(characterSelf.character_id) ?? 'Unknown character'
  } else {
    const corporationId = Number(corpSelf?.corporation_id)
    const { data: corpName } = await supabase
      .from('universe_name')
      .select('name')
      .eq('id', corporationId)
      .maybeSingle<{ name: string }>()
    ownerName = corpName?.name ?? `Corporation #${corporationId}`
  }

  const typeNames = await fetchTypeNames([Number(self.type_id)])
  const typeName = typeNames[Number(self.type_id)] ?? `#${self.type_id}`
  const heading = self.name && self.name !== typeName ? `${self.name} (${typeName})` : typeName

  const typeNamesPromise = fetchTypeNames(children.map((c) => Number(c.type_id)))
  // Display-only in the shared view: no href (a nested container would need its
  // own share token to open), and contents is unused without drill-down links.
  const rows: ItemRow[] = children
    .map((c) => ({
      itemId: String(c.item_id),
      ownerId,
      typeId: Number(c.type_id),
      name: c.name ?? null,
      quantity: c.quantity,
      isSingleton: c.is_singleton,
      flag: c.location_flag,
      contents: 0,
      isCurrentShip: false,
      href: null,
    }))
    .sort((a, b) => a.typeId - b.typeId)

  return (
    <>
      <h1 className="serif">{heading}</h1>
      <p>
        Owner: <span className="serif">{ownerName}</span>
      </p>
      <ShipFitViewDynamic esiFit={toEsiFit(Number(self.type_id), self.name ?? null, rows)} />
      <ShipCargo rows={rows} typeNamesPromise={typeNamesPromise} />
    </>
  )
}

export default ShipPage
