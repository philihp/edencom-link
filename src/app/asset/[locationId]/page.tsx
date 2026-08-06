import type { SupabaseClient } from '@supabase/supabase-js'
import { notFound, redirect } from 'next/navigation'
import { Suspense } from 'react'

import { getSdeSystem } from '@/sdeSystems'
import { getSdeType } from '@/sdeTypes'
import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { AssetPath, fetchAssetPath, regionSystemCrumbs, type Crumb } from '../../assetPath'
import { fetchOwners } from '../../owners'
import type { Owners } from '../../ownerFilter'
import { SkeletonTable } from '../../skeleton'
import { fetchStationNames, fetchStationSystems } from '../../stationNames'
import { fetchSystemNames } from '../../systemNames'
import { TypeIcon } from '../../typeIcon'
import { resolveShareParams } from '../access'
import { saveAssetShare, revokeAssetShare } from '../shareActions'
import { fetchShareDialogData } from '../shareData'
import { ShareDialog } from '../shareDialog'
import styles from '../assets.module.css'
import { AppraisalPanel } from './appraisalPanel'
import { SHIP_CATEGORY_ID, fetchRootItems, type CharacterAsset, type CorpAsset } from './locationData'
import { LocationItems } from './locationItems'
import { SystemLocationsSection } from './systemLocationsSection'

type Structure = {
  structure_id: number | string
  name: string | null
  system_id: number | string | null
}

// The location itself, when the id turns out to be one of our own items rather
// than a place — a ship or container the user drilled into.
type Self = Pick<CharacterAsset, 'item_id' | 'type_id' | 'location_id' | 'name'>

// Whether this id is one of the caller's own items, and whose. Both tables are
// probed at once and the character row wins: an item lives in exactly one of
// them, so the extra lookup is a cheap indexed miss rather than a second
// round trip waiting on the first to come back empty.
const fetchSelf = async (
  supabase: SupabaseClient,
  locationId: string,
  characterScope: string[] | null,
  corpScope: number[] | null
): Promise<{ self: Self | null; isOwnCharacterItem: boolean }> => {
  let selfQuery = supabase
    .from('character_asset')
    .select('item_id, registration_id, type_id, location_id, name')
    .eq('item_id', locationId)
  if (characterScope) selfQuery = selfQuery.in('registration_id', characterScope)
  let corpSelfQuery = supabase
    .from('corp_asset')
    .select('item_id, corporation_id, type_id, location_id')
    .eq('item_id', locationId)
  if (corpScope) corpSelfQuery = corpSelfQuery.in('corporation_id', corpScope)

  const [{ data: characterSelf }, { data: corpSelf }] = await Promise.all([
    selfQuery.maybeSingle<Pick<CharacterAsset, 'item_id' | 'registration_id' | 'type_id' | 'location_id' | 'name'>>(),
    corpSelfQuery.maybeSingle<Pick<CorpAsset, 'item_id' | 'corporation_id' | 'type_id' | 'location_id'>>(),
  ])

  return {
    self: characterSelf ?? (corpSelf ? { ...corpSelf, name: null } : null),
    isOwnCharacterItem: characterSelf != null,
  }
}

// Everything the heading needs when the id is a place rather than an item:
// which structure/station/system it is, and the system it sits in. Resolved the
// same way the index page does — own-corp + foreign player structures, NPC
// stations, and systems all come from the universe_name DB cache.
//
// The four lookups are independent of each other, so they go out together; only
// the system *name* has to wait, since which system to name depends on them.
const fetchPlace = async (
  supabase: SupabaseClient,
  locationId: string,
  corpScope: number[] | null,
  // The location_type the root items report, when there are any. A location
  // holding items already says what kind of place it is.
  locationType: string | null
) => {
  const numericId = Number(locationId)

  let corpStructureQuery = supabase
    .from('corp_structure')
    .select('structure_id, name, system_id')
    .eq('structure_id', numericId)
  if (corpScope) corpStructureQuery = corpStructureQuery.in('corporation_id', corpScope)

  const [{ data: corpStructures }, { data: playerStructures }, stationNames, stationSystems, sdeSystemProbe] =
    await Promise.all([
      corpStructureQuery,
      supabase.from('universe_structure').select('structure_id, name, system_id').eq('structure_id', numericId),
      fetchStationNames([numericId]),
      fetchStationSystems([numericId]),
      // A system id resolves in the SDE; a station/structure id doesn't. Only
      // needed when the type is unknown (no root items) — the case that needs
      // disambiguating: a system opened directly with nothing floating in its
      // space. Fired alongside the structure lookups rather than after them (it
      // is a process-cached SDE read, so an unused probe costs nothing) and
      // discarded below if this turns out to be a structure.
      locationType == null && Number.isFinite(numericId) ? getSdeSystem(numericId) : null,
    ])

  const structure = (corpStructures?.[0] ?? playerStructures?.[0] ?? null) as Structure | null
  const sdeSystem = structure ? null : sdeSystemProbe
  const isSolarSystem = !structure && (locationType === 'solar_system' || sdeSystem != null)

  const systemId = isSolarSystem
    ? numericId
    : structure?.system_id != null
      ? Number(structure.system_id)
      : stationSystems[numericId]
  const systemNames = await fetchSystemNames(
    [systemId, isSolarSystem ? numericId : undefined].filter((n): n is number => n != null)
  )

  const heading =
    (structure
      ? (structure.name ?? `Structure #${locationId}`)
      : isSolarSystem
        ? (systemNames[numericId] ?? sdeSystem?.name ?? `System #${locationId}`)
        : stationNames[numericId]) ?? `Location #${locationId}`

  return {
    heading,
    isSolarSystem,
    systemId,
    systemName: systemId != null ? (systemNames[systemId] ?? `#${systemId}`) : undefined,
  }
}

// The share-token path has no session to read owner names with, so they come
// from the resolved scope through the service client instead.
const fetchScopeOwners = async (
  supabase: SupabaseClient,
  scope: NonNullable<Awaited<ReturnType<typeof resolveShareParams>>>
): Promise<Owners> => {
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
  return { characters, corporations }
}

// Directory browsing for a location's contents. Ships are their own thing —
// navigating to a ship's id redirects to /ship/[itemId]. Reachable
// authenticated (RLS scopes everything), or anonymously with a hangar share
// token (?token=…, no UI mints these yet): that path uses the service-role
// client, so every query is explicitly filtered to the sharing user's
// characters/corps — a shared station view must never reveal other users'
// items parked in the same station.
//
// The page is deliberately split in two. What runs before the first byte is
// only what the answer depends on: the share/auth check, the root items, who
// this location is, and — because it decides whether this page is a redirect at
// all — whether the id names a ship. Everything expensive (the per-container
// subtree counts, and on a system page the whole-hangar location sweep) hangs
// off a Suspense boundary below, so the heading and breadcrumb don't wait on it.
const AssetLocationPage = async ({
  params,
  searchParams,
}: {
  params: Promise<{ locationId: string }>
  searchParams: Promise<{ token?: string; share?: string }>
}) => {
  const { locationId } = await params
  const { token, share } = await searchParams

  const scope = token || share ? await resolveShareParams({ token, share }, locationId) : null
  if ((token || share) && !scope) notFound()

  const supabase = scope ? createServiceClient() : await createClient()
  if (!scope) {
    const { data: auth, error: authError } = await supabase.auth.getUser()
    if (authError || !auth?.user) {
      redirect('/')
    }
  }

  // In the token path every query must stay inside the sharer's scope; an
  // empty corp list still needs a filter that matches nothing.
  const characterScope = scope?.registrationIds ?? null
  const corpScope = scope ? (scope.corporationIds.length > 0 ? scope.corporationIds : [-1]) : null

  // Nothing here depends on anything else here, so it all goes out at once.
  // These used to run one after another, each waiting on a round trip that had
  // no reason to wait.
  const [{ rootItems, currentShipItemIds }, { self, isOwnCharacterItem }, owners] = await Promise.all([
    fetchRootItems(supabase, locationId, characterScope, corpScope),
    fetchSelf(supabase, locationId, characterScope, corpScope),
    // Owner names for the filter dropdown: the caller's own owners, or — in the
    // token path — the sharer's characters/corps, resolved through the service
    // client (the anonymous viewer has no session to read them with).
    scope ? fetchScopeOwners(supabase, scope) : fetchOwners(),
  ])

  // The self type answers two questions at once — what to call this container,
  // and whether it's a ship — off one process-cached SDE read.
  const selfType = self ? await getSdeType(Number(self.type_id)) : null

  // A ship is its own page, not a directory level (a share link stays valid
  // through the redirect — a signed link covers the whole shared subtree, a
  // legacy token is bound to this same id).
  if (self && selfType?.categoryID === SHIP_CATEGORY_ID) {
    redirect(`/ship/${locationId}${share ? `?share=${share}` : token ? `?token=${token}` : ''}`)
  }

  // Share dialog data for an owned character item; fetchShareDialogData returns
  // null unless the caller actually owns it (visibility alone can now mean
  // "shared with me"). Started rather than awaited: whether the item is ours was
  // settled above, so this overlaps the heading work below instead of queueing
  // behind it.
  const shareDataPromise = !scope && isOwnCharacterItem ? fetchShareDialogData(supabase, locationId) : null

  // Where this location lives: the full container chain up to its root place,
  // rendered as the breadcrumb above the heading. A bare place (station /
  // structure / system) has no ancestry, so its path is just the Assets root.
  // The ancestry RPC is skipped in the token path: it would walk unscoped as
  // service_role, and a shared hangar shouldn't reveal where it lives anyway.
  let heading: string
  let crumbs: Crumb[] = [{ href: '/asset', label: 'Assets' }]
  let systemName: string | undefined
  // True when the id is a solar system: its heading is the system name, and it
  // lists the stations/structures in the system where we hold assets rather
  // than only the items floating in its space.
  let isSolarSystem = false
  let systemId: number | null = null

  if (self) {
    // A container: title it by its custom name (if any) plus type. The type
    // name is already in hand from the redirect check above, so naming it costs
    // no round trip of its own.
    const typeName = selfType?.name ?? `#${self.type_id}`
    heading = self.name && self.name !== typeName ? `${self.name} (${typeName})` : typeName
    if (!scope) crumbs = await fetchAssetPath(locationId, supabase)
  } else {
    const place = await fetchPlace(supabase, locationId, corpScope, rootItems[0]?.location_type ?? null)
    heading = place.heading
    isSolarSystem = place.isSolarSystem
    systemId = place.systemId ?? null
    systemName = place.systemName

    // Breadcrumb: region › system for this place (the place itself is the
    // heading). For a bare solar system the system is the heading, so only the
    // region shows. Falls back to the Assets root when it can't be placed.
    const prefix = await regionSystemCrumbs(place.systemId, place.systemName, place.isSolarSystem)
    if (prefix.length > 0) {
      crumbs = prefix
      // The system now lives in the breadcrumb (region › system), so drop the
      // redundant "System:" line below the heading. Kept only in the Assets
      // fallback, where the breadcrumb can't show the system.
      systemName = undefined
    }
  }

  const shareData = shareDataPromise ? await shareDataPromise : null

  const items = (
    <Suspense fallback={<ItemsFallback />}>
      <LocationItems
        supabase={supabase}
        locationId={locationId}
        rootItems={rootItems}
        currentShipItemIds={currentShipItemIds}
        owners={owners}
        linkable={!scope}
      />
    </Suspense>
  )

  return (
    <>
      {!scope ? <AssetPath crumbs={crumbs} current={heading} /> : null}
      <div className={styles.header}>
        <h1 className="serif">
          {/* A container drilled into is an item like any other, so it wears its
              own icon; a station/structure/system has no type id to draw one from. */}
          {self ? <TypeIcon id={Number(self.type_id)} size={32} /> : null}
          {heading}
        </h1>
        <div className={styles.headerActions}>
          {/* Prices this whole place in one request — the same endpoint each row
              uses, just aimed at the location instead of an item. */}
          {!scope ? <AppraisalPanel targets={[locationId]} label="Appraise everything here" /> : null}
          {/* Sharing is per-item: only an owned character item (a container
              drilled into) gets the dialog — never a station/structure/system,
              and never something merely shared with the viewer. */}
          {shareData ? (
            <ShareDialog
              subjectLabel="item"
              urlPath={`/asset/${locationId}`}
              data={shareData}
              save={saveAssetShare.bind(null, locationId)}
              revoke={revokeAssetShare.bind(null, locationId)}
            />
          ) : null}
        </div>
      </div>
      {systemName && systemName !== heading ? (
        <p>
          System: <span className="serif">{systemName}</span>
        </p>
      ) : null}

      {isSolarSystem ? (
        <>
          {!scope && systemId != null ? (
            <Suspense fallback={<SystemLocationsFallback />}>
              <SystemLocationsSection supabase={supabase} locationId={locationId} systemId={systemId} owners={owners} />
            </Suspense>
          ) : null}
          {/* Items floating directly in the system's space (not docked in any of
              its stations) — usually none, so only shown when present. */}
          {rootItems.length > 0 ? (
            <>
              <h2 className="serif">In space</h2>
              {items}
            </>
          ) : null}
        </>
      ) : (
        items
      )}
    </>
  )
}
export default AssetLocationPage

// Same shape the route's loading.tsx uses, so a streamed-in table and a
// freshly-navigated one look like the same page at the same stage.
const ItemsFallback = () => (
  <SkeletonTable
    columns={['Quantity', 'Item', 'Volume (m³)', 'Group', 'Category', 'Owner', 'Hangar', 'Contents']}
    numeric={['Quantity', 'Volume (m³)', 'Contents']}
    rows={8}
  />
)

const SystemLocationsFallback = () => <SkeletonTable columns={['Location', 'Items']} numeric={['Items']} rows={5} />
