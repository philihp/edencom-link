import { notFound, redirect } from 'next/navigation'
import { Suspense } from 'react'

import { getSdeType, getSdeTypes } from '@/sdeTypes'
import { createClient } from '@/utils/supabase/server'

import { establishedUser } from '../../account/lib/establishedUser'
import { createServiceClient } from '@/utils/supabase/service'
import { AssetPath, fetchAssetPath } from '../../assetPath'
import { ShareUrlCleanup } from '../../shareUrlCleanup'
import { typeFacts } from '../../assetTypeFacts'
import type { Owners } from '../../ownerFilter'
import { SkeletonTable } from '../../skeleton'
import { fetchTypeNames } from '../../typeNames'
import { AppraisalPanel } from '../../asset/[locationId]/appraisalPanel'
import { LocationAssets, type ItemRow } from '../../asset/[locationId]/locationAssets'
import { resolveShareParams } from '../../asset/access'
import { saveAssetShare, revokeAssetShare } from '../../asset/shareActions'
import { fetchShareDialogData } from '../../asset/shareData'
import { ShareDialog } from '../../asset/shareDialog'
import { toEsiFit } from '../../ship/[itemId]/esfFit'
import { FitPlaceholder } from './fitPlaceholder'
import { characterPortrait, corporationLogo, ShipHeading, type ShipOwner } from '../../ship/[itemId]/shipHeading'
import { fetchShipOwner } from '../../ship/[itemId]/shipOwner'
import { ShipContents } from './shipContents'
import { ShipFitViewDynamic } from './shipFitViewDynamic'
import { SHIP_CATEGORY_ID, fittingOrder, hullRow, type ChildRow } from '../../ship/[itemId]/shipRows'

type ShipRow = {
  item_id: number | string
  type_id: number | string
  location_id?: number | string | null
  location_type?: string | null
  name: string | null
  registration_id?: string
  corporation_id?: number | string
}

// The retiring ship page: the eveship.fit wheel + stats built from its fitted
// modules, a full module/cargo table in fitting order (the same sortable
// LocationAssets table the asset browser uses), owner and location.
//
// This is what /ship/[itemId] rendered until stage 4 phase 2 of
// docs/custom-fit-ui.md swapped the two paths. It stays reachable, unlinked,
// so the embed can still be compared against the viewer that replaced it;
// phase 3 deletes it along with @eveshipfit/react. Nothing new should be
// added here — the ship page is /ship.
//
// Reachable
// authenticated (RLS scopes everything to the caller), or anonymously with a
// valid share token — the token path uses the service-role client, so every
// query there is explicitly filtered to the sharing user's characters/corps,
// and location is deliberately omitted (a share link shouldn't broadcast
// where the ship is).
const ShipPage = async ({
  params,
  searchParams,
}: {
  params: Promise<{ itemId: string }>
  searchParams: Promise<{ token?: string; share?: string }>
}) => {
  const { itemId } = await params
  const { token, share } = await searchParams

  if (token || share) return <SharedShipPage itemId={itemId} shareParams={{ token, share }} />

  const supabase = await createClient()
  const user = await establishedUser(supabase)
  if (!user) {
    redirect('/')
  }

  // The ship row, from whichever hangar owns it. Both hangars are probed at
  // once and the character row wins: an item lives in exactly one of them, so
  // the corp lookup is a cheap indexed miss rather than a second round trip
  // waiting on the first to come back empty.
  const [{ data: characterSelf }, { data: corpSelf }] = await Promise.all([
    supabase
      .from('character_asset')
      .select('item_id, registration_id, type_id, location_id, location_type, name')
      .eq('item_id', itemId)
      .maybeSingle<ShipRow>(),
    supabase
      .from('corp_asset')
      .select('item_id, corporation_id, type_id, location_id, location_type')
      .eq('item_id', itemId)
      .maybeSingle<ShipRow>(),
  ])
  const self = characterSelf ?? corpSelf
  if (!self) notFound()

  // One process-cached SDE read answers both questions this page opens with:
  // whether the id is a ship at all, and what to call it.
  const selfType = await getSdeType(Number(self.type_id))
  // Non-ships (containers, loose stacks) live on the asset browser instead.
  if (selfType?.categoryID !== SHIP_CATEGORY_ID) redirect(`/asset/${itemId}`)

  const typeName = selfType?.name ?? `#${self.type_id}`
  const heading = self.name && self.name !== typeName ? `${self.name} (${typeName})` : typeName

  // Who this ship is and where it sits — all independent of each other, and of
  // the contents below, so they go out together.
  const [owner, crumbs, shareData] = await Promise.all([
    fetchShipOwner(supabase, characterSelf, corpSelf),
    // The full container chain up to its station / structure / system,
    // rendered as the breadcrumb above the heading.
    fetchAssetPath(itemId, supabase),
    // The share dialog appears only for a character item the caller actually
    // owns — with phase 2's widening policy, RLS visibility alone can also mean
    // "shared with me", which must not offer the dialog.
    fetchShareDialogData(supabase, itemId),
  ])

  return (
    <>
      <AssetPath crumbs={crumbs} current={heading} />
      <ShipHeading
        typeId={Number(self.type_id)}
        heading={heading}
        owner={owner}
        actions={
          <>
            {/* The hull plus everything nested inside it — the same set the
                table below lists, priced in one request. */}
            <AppraisalPanel targets={[itemId]} label="Appraise ship" />
            {shareData ? (
              <ShareDialog
                subjectLabel="ship"
                urlPath={`/ship/${itemId}`}
                data={shareData}
                save={saveAssetShare.bind(null, itemId)}
                revoke={revokeAssetShare.bind(null, itemId)}
              />
            ) : null}
          </>
        }
      />
      <Suspense fallback={<ContentsFallback />}>
        <ShipContents
          supabase={supabase}
          itemId={itemId}
          self={self}
          ownerId={characterSelf?.registration_id ?? String(corpSelf?.corporation_id)}
        />
      </Suspense>
    </>
  )
}

// While the child query and its subtree walk are in flight: the fit viewer's
// own reserved footprint (it has a second, client-side wait after this) above a
// stand-in for the module table.
const ContentsFallback = () => (
  <>
    <FitPlaceholder />
    <SkeletonTable
      columns={['Quantity', 'Item', 'Volume (m³)', 'Group', 'Category', 'Owner', 'Hangar', 'Contents']}
      numeric={['Quantity', 'Volume (m³)', 'Contents']}
      rows={8}
    />
  </>
)

// Anonymous share-link view: wheel + name + owner only. All queries run on
// the service client, explicitly filtered to the sharer's characters/corps.
// Accepts both link generations — the signed ?share= param (recursive over
// the shared subtree) and the legacy ?token= (exact id).
const SharedShipPage = async ({
  itemId,
  shareParams,
}: {
  itemId: string
  shareParams: { token?: string; share?: string }
}) => {
  const scope = await resolveShareParams(shareParams, itemId)
  if (!scope) notFound()

  const supabase = createServiceClient()
  const { data: characterSelf } = await supabase
    .from('character_asset')
    .select('item_id, registration_id, type_id, name')
    .eq('item_id', itemId)
    .in('registration_id', scope.registrationIds)
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
  if (!self || (await getSdeType(Number(self.type_id)))?.categoryID !== SHIP_CATEGORY_ID) notFound()

  const [{ data: characterChildren }, { data: corpChildren }] = await Promise.all([
    supabase
      .from('character_asset')
      .select('item_id, type_id, location_flag, quantity, is_singleton, is_blueprint_copy, name')
      .eq('location_id', itemId)
      .in('registration_id', scope.registrationIds),
    supabase
      .from('corp_asset')
      .select('item_id, type_id, location_flag, quantity, is_singleton, is_blueprint_copy')
      .eq('location_id', itemId)
      .in('corporation_id', scope.corporationIds.length > 0 ? scope.corporationIds : [-1]),
  ])
  const children = [...((characterChildren ?? []) as ChildRow[]), ...((corpChildren ?? []) as ChildRow[])]

  // Everything inside a ship belongs to whoever owns the ship, so the whole
  // cargo view carries a single owner.
  const ownerId = characterSelf?.registration_id ?? String(corpSelf?.corporation_id)
  let owner: ShipOwner
  if (characterSelf?.registration_id) {
    // The share scope carries the sharer's name but not their EVE id, which is
    // what the portrait is keyed on — one lookup on the registration the scope
    // already vouched for.
    const { data: registration } = await supabase
      .from('registration')
      .select('character_id')
      .eq('id', characterSelf.registration_id)
      .maybeSingle<{ character_id: number | string | null }>()
    owner = {
      name: scope.characterNames.get(characterSelf.registration_id) ?? 'Unknown character',
      portrait: registration?.character_id == null ? null : characterPortrait(registration.character_id),
    }
  } else {
    const corporationId = Number(corpSelf?.corporation_id)
    const { data: corpName } = await supabase
      .from('universe_name')
      .select('name')
      .eq('id', corporationId)
      .maybeSingle<{ name: string }>()
    owner = { name: corpName?.name ?? `Corporation #${corporationId}`, portrait: corporationLogo(corporationId) }
  }

  const typeNames = await fetchTypeNames([Number(self.type_id)])
  const typeName = typeNames[Number(self.type_id)] ?? `#${self.type_id}`
  const heading = self.name && self.name !== typeName ? `${self.name} (${typeName})` : typeName

  const typeNamesPromise = fetchTypeNames([Number(self.type_id), ...children.map((c) => Number(c.type_id))])
  // The same bulk lookup the signed-in view does, for the volume/group/category
  // columns and each row's icon variation. Pure SDE data — public-read, nothing
  // owner-specific — so it's as safe on the share path as the type names are.
  const childTypes = await getSdeTypes([Number(self.type_id), ...children.map((c) => Number(c.type_id))])
  // Display-only in the shared view: no href (a nested container would need its
  // own share token to open), and contents is unused without drill-down links.
  const rows: ItemRow[] = fittingOrder(
    children.map((c) => ({
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
      ...typeFacts(childTypes[Number(c.type_id)], c.is_blueprint_copy),
    }))
  )

  // The table's owner column/filter only ever sees the sharing owner — the
  // anonymous viewer has no owner context of their own to offer.
  const owners: Owners = characterSelf?.registration_id
    ? { characters: [{ id: characterSelf.registration_id, name: owner.name }], corporations: [] }
    : { characters: [], corporations: [{ id: String(corpSelf?.corporation_id), name: owner.name }] }

  return (
    <>
      {shareParams.share && <ShareUrlCleanup />}
      <ShipHeading typeId={Number(self.type_id)} heading={heading} owner={owner} />
      <ShipFitViewDynamic esiFit={toEsiFit(Number(self.type_id), self.name ?? null, rows)} />
      {/* Hull first here too, so a shared ship lists the same things the
          owner's own view does. Contents counts are unavailable on this path
          (the walk RPCs are skipped), so it reports none rather than a guess. */}
      <LocationAssets
        rows={[hullRow(self, ownerId, childTypes[Number(self.type_id)], 0), ...rows]}
        owners={owners}
        typeNamesPromise={typeNamesPromise}
        canAppraise={false}
      />
    </>
  )
}

export default ShipPage
