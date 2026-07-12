import { notFound, redirect } from 'next/navigation'

import { getSdeType } from '@/sdeTypes'
import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { AssetPath, fetchAssetPath, type Crumb } from '../../assetPath'
import { fetchOwners } from '../../owners'
import { resolveShareToken } from '../../ship/access'
import { fetchStationNames, fetchStationSystems } from '../../stationNames'
import { fetchSystemNames } from '../../systemNames'
import { fetchTypeNames } from '../../typeNames'
import type { Owners } from '../../ownerFilter'
import { LocationAssets, type ItemRow } from './locationAssets'

// invGroups.categoryID for the Ship category in CCP's SDE.
const SHIP_CATEGORY_ID = 6

// Bigint ids arrive from PostgREST as strings; keep them as strings and only
// convert at the API/system-lookup boundary (mirrors the assets index page).
type CharacterAsset = {
  item_id: number | string
  character_id: string
  type_id: number | string
  location_id: number | string | null
  location_flag: string | null
  location_type: string | null
  quantity: number | string | null
  is_singleton: boolean | null
  name: string | null
}

// Corp assets carry no player-assigned name column; owner is the corporation.
type CorpAsset = Omit<CharacterAsset, 'character_id' | 'name'> & { corporation_id: number | string }

// Either source's row, normalized to whoever owns it: a character
// (registration uuid) or a corporation (EVE corporation id).
type Asset = Omit<CharacterAsset, 'character_id'> & { owner_id: string }

type Structure = {
  structure_id: number | string
  name: string | null
  system_id: number | string | null
}

const isShip = (typeId: number | string) => getSdeType(Number(typeId))?.categoryID === SHIP_CATEGORY_ID

// Directory browsing for a location's contents. Ships are their own thing —
// navigating to a ship's id redirects to /ship/[itemId]. Reachable
// authenticated (RLS scopes everything), or anonymously with a hangar share
// token (?token=…, no UI mints these yet): that path uses the service-role
// client, so every query is explicitly filtered to the sharing user's
// characters/corps — a shared station view must never reveal other users'
// items parked in the same station.
const AssetLocationPage = async ({
  params,
  searchParams,
}: {
  params: Promise<{ locationId: string }>
  searchParams: Promise<{ token?: string }>
}) => {
  const { locationId } = await params
  const { token } = await searchParams

  const scope = token ? await resolveShareToken(token, locationId) : null
  if (token && !scope) notFound()

  const supabase = scope ? createServiceClient() : await createClient()
  if (!scope) {
    const { data: auth, error: authError } = await supabase.auth.getUser()
    if (authError || !auth?.user) {
      redirect('/')
    }
  }

  // In the token path every query must stay inside the sharer's scope; an
  // empty corp list still needs a filter that matches nothing.
  const characterScope = scope?.characterIds ?? null
  const corpScope = scope ? (scope.corporationIds.length > 0 ? scope.corporationIds : [-1]) : null

  // Root-level assets at this location: ships, containers and loose stacks that
  // sit directly in the station/structure/system (not nested in another item),
  // from both the character and corp hangars. Only this level is fetched — the
  // whole asset table no longer pages into Node.
  let characterQuery = supabase
    .from('character_asset')
    .select('item_id, character_id, type_id, location_id, location_flag, location_type, quantity, is_singleton, name')
    .eq('location_id', locationId)
  if (characterScope) characterQuery = characterQuery.in('character_id', characterScope)
  let corpQuery = supabase
    .from('corp_asset')
    .select('item_id, corporation_id, type_id, location_id, location_flag, location_type, quantity, is_singleton')
    .eq('location_id', locationId)
  if (corpScope) corpQuery = corpQuery.in('corporation_id', corpScope)
  // A character's currently-piloted ship reports its location as wherever it's
  // docked — physically indistinguishable from any other ship parked there —
  // so it otherwise shows up as an ordinary item in that station's listing.
  // Still shown (it belongs here from the DB's point of view), but flagged so
  // the UI can tell it apart from a ship that's merely parked.
  let currentShipQuery = supabase.from('character_ship').select('ship_item_id')
  if (characterScope) currentShipQuery = currentShipQuery.in('character_id', characterScope)
  const [{ data: characterChildren }, { data: corpChildren }, { data: currentShips }] = await Promise.all([
    characterQuery,
    corpQuery,
    currentShipQuery,
  ])
  const currentShipItemIds = new Set(
    ((currentShips ?? []) as { ship_item_id: number | string }[]).map((s) => String(s.ship_item_id))
  )
  const rootItems: Asset[] = [
    ...((characterChildren ?? []) as CharacterAsset[]).map(({ character_id, ...a }) => ({
      ...a,
      owner_id: character_id,
    })),
    ...((corpChildren ?? []) as CorpAsset[]).map(({ corporation_id, ...a }) => ({
      ...a,
      owner_id: String(corporation_id),
      name: null,
    })),
  ]

  // Total items held inside each ship/container at this location, counted across
  // the whole subtree by the *_asset_location_contents() functions in Postgres.
  // An item lives in exactly one of the two tables, so the maps can't collide.
  // Skipped in the token path: those functions walk every asset unscoped when
  // run as service_role, and a shared hangar doesn't offer drill-down anyway.
  const contentsByItem = new Map<string, number>()
  if (!scope) {
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

  // The id is either a place (station / structure / solar system) or one of our
  // own items — a ship or container the user drilled into, character- or
  // corp-owned. Resolve the heading and the "back" target accordingly.
  let selfQuery = supabase
    .from('character_asset')
    .select('item_id, character_id, type_id, location_id, name')
    .eq('item_id', locationId)
  if (characterScope) selfQuery = selfQuery.in('character_id', characterScope)
  const { data: characterSelf } =
    await selfQuery.maybeSingle<Pick<CharacterAsset, 'item_id' | 'character_id' | 'type_id' | 'location_id' | 'name'>>()
  let corpSelfQuery = supabase
    .from('corp_asset')
    .select('item_id, corporation_id, type_id, location_id')
    .eq('item_id', locationId)
  if (corpScope) corpSelfQuery = corpSelfQuery.in('corporation_id', corpScope)
  const { data: corpSelf } = characterSelf
    ? { data: null }
    : await corpSelfQuery.maybeSingle<Pick<CorpAsset, 'item_id' | 'corporation_id' | 'type_id' | 'location_id'>>()
  const self = characterSelf ?? (corpSelf ? { ...corpSelf, name: null } : null)

  // A ship is its own page, not a directory level (a ship share token stays
  // valid through the redirect — it's bound to the same id).
  if (self && isShip(self.type_id)) {
    redirect(`/ship/${locationId}${token ? `?token=${token}` : ''}`)
  }

  let heading: string
  // Where this location lives: the full container chain up to its root place,
  // rendered as the breadcrumb above the heading. A bare place (station /
  // structure / system) has no ancestry, so its path is just the Assets root.
  // Skipped in the token path: the RPC would walk unscoped as service_role,
  // and a shared hangar shouldn't reveal where it lives anyway.
  let crumbs: Crumb[] = [{ href: '/asset', label: 'Assets' }]
  let systemName: string | undefined

  if (self) {
    // A container: title it by its custom name (if any) plus type.
    const typeNames = await fetchTypeNames([Number(self.type_id)])
    const typeName = typeNames[Number(self.type_id)] ?? `#${self.type_id}`
    heading = self.name && self.name !== typeName ? `${self.name} (${typeName})` : typeName
    if (!scope) {
      crumbs = await fetchAssetPath(locationId, supabase)
    }
  } else {
    // Resolve the location's own name/system the same way the index page does:
    // own-corp + foreign player structures, NPC stations, and systems all come
    // from the universe_name DB cache.
    const numericId = Number(locationId)
    let corpStructureQuery = supabase
      .from('corp_structure')
      .select('structure_id, name, system_id')
      .eq('structure_id', numericId)
    if (corpScope) corpStructureQuery = corpStructureQuery.in('corporation_id', corpScope)
    const { data: corpStructures } = await corpStructureQuery
    const { data: playerStructures } = await supabase
      .from('universe_structure')
      .select('structure_id, name, system_id')
      .eq('structure_id', numericId)
    const structure = (corpStructures?.[0] ?? playerStructures?.[0] ?? null) as Structure | null

    const locationType = rootItems[0]?.location_type ?? null
    const [stationNames, stationSystems] = await Promise.all([
      fetchStationNames([numericId]),
      fetchStationSystems([numericId]),
    ])

    const systemId = structure?.system_id != null ? Number(structure.system_id) : stationSystems[numericId]
    const systemNames = await fetchSystemNames(
      [systemId, locationType === 'solar_system' ? numericId : undefined].filter((n): n is number => n != null)
    )

    heading =
      (structure
        ? (structure.name ?? `Structure #${locationId}`)
        : (stationNames[numericId] ?? (locationType === 'solar_system' ? systemNames[numericId] : undefined))) ??
      `Location #${locationId}`
    systemName = systemId != null ? (systemNames[systemId] ?? `#${systemId}`) : undefined
  }

  // Owner names for the filter dropdown: the caller's own owners, or — in the
  // token path — the sharer's characters/corps, resolved through the service
  // client (the anonymous viewer has no session to read them with).
  let owners: Owners
  if (scope) {
    const characters = [...scope.characterNames]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name))
    let corpNames: Record<number, string> = {}
    if (scope.corporationIds.length > 0) {
      const { data } = await supabase.from('universe_name').select('id, name').in('id', scope.corporationIds)
      corpNames = Object.fromEntries(
        ((data ?? []) as Array<{ id: number | string; name: string }>).map((r) => [Number(r.id), r.name])
      )
    }
    const corporations = scope.corporationIds
      .map((id) => ({ id: String(id), name: corpNames[id] ?? `Corporation #${id}` }))
      .sort((a, b) => a.name.localeCompare(b.name))
    owners = { characters, corporations }
  } else {
    owners = await fetchOwners()
  }

  // Resolve type names without blocking render: fire the lookup and let each
  // TypeName stream in (Suspense), falling back to #id. A big hangar can hold
  // hundreds of distinct types, and awaiting them all here times the page out.
  const typeNamesPromise = fetchTypeNames(rootItems.map((a) => Number(a.type_id)))

  // Containers/ships (those holding items) first, then a stable id order.
  // Anonymous hangar viewers get no drill-down links: nested levels would
  // need their own tokens.
  const rows: ItemRow[] = rootItems
    .map((a) => {
      const contents = contentsByItem.get(String(a.item_id)) ?? 0
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
        href: scope ? null : isShip(a.type_id) ? `/ship/${a.item_id}` : contents > 0 ? `/asset/${a.item_id}` : null,
      }
    })
    .sort((a, b) => b.contents - a.contents || a.typeId - b.typeId)

  return (
    <>
      {!scope ? <AssetPath crumbs={crumbs} current={heading} /> : null}
      <h1 className="serif">{heading}</h1>
      {systemName && systemName !== heading ? (
        <p>
          System: <span className="serif">{systemName}</span>
        </p>
      ) : null}

      <LocationAssets rows={rows} owners={owners} typeNamesPromise={typeNamesPromise} />
    </>
  )
}
export default AssetLocationPage
