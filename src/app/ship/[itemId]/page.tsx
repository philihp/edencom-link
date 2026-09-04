import { notFound, redirect } from 'next/navigation'
import { Suspense } from 'react'

import { getSdeType, getSdeTypes } from '@/sdeTypes'
import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'

import { establishedUser } from '../../account/lib/establishedUser'
import { AppraisalPanel } from '../../asset/[locationId]/appraisalPanel'
import { resolveShareParams } from '../../asset/access'
import { revokeAssetShare, saveAssetShare } from '../../asset/shareActions'
import { fetchShareDialogData } from '../../asset/shareData'
import { ShareDialog } from '../../asset/shareDialog'
import { AssetPath, fetchAssetPath, type Crumb } from '../../assetPath'
import { ShareUrlCleanup } from '../../shareUrlCleanup'
import { SkeletonTable } from '../../skeleton'
import { eftTypes, shipEft } from './eft'
import { toEsiFit } from './esfFit'
import { FitExport } from './fitExport'
import { ShipIdentity } from './identity'
import { ShipContents, SharedShipContents } from './shipContents'
import { characterPortrait, corporationLogo, type ShipOwner } from './shipHeading'
import { fetchShipOwner } from './shipOwner'
import { SHIP_CATEGORY_ID, fittingOrder, type ChildRow } from './shipRows'
import { ShipViewDynamic } from './shipViewDynamic'

// A ship's own page: the fitting ring, what's fitted to it, what's aboard and
// what the dogma engine makes of the whole thing, over the module/cargo table
// that drills into whatever is nested inside. The viewer is our own stack
// (docs/custom-fit-ui.md) rather than the eveship.fit embed; the old embed page
// still stands at /item/[itemId] until stage 4 phase 3 deletes it.
//
// Reachable authenticated (RLS scopes everything to the caller), or anonymously
// with a valid share token — the token path uses the service-role client, so
// every query there is explicitly filtered to the sharing user's
// characters/corps, and location is deliberately omitted (a share link
// shouldn't broadcast where the ship is).

type ShipRow = {
  item_id: number | string
  type_id: number | string
  name: string | null
  registration_id?: string
  corporation_id?: number | string
}

// Where the hull sits, as the identity strip says it: the nearest named place
// and the system holding it ("Cold Storage, C-J6MT"). The breadcrumb above
// already spells the whole chain out, so this is deliberately its tail.
const locationLabel = (crumbs: Crumb[]): string | null => {
  const places = crumbs.filter((crumb) => crumb.label !== 'Assets')
  if (places.length === 0) return null
  return places
    .slice(-2)
    .reverse()
    .map((crumb) => crumb.label)
    .join(', ')
}

// Only the four fields toEsiFit and the EFT writer read — the rest of an
// ItemRow describes the table, which builds its own rows from the same
// children.
const fitRows = (children: ChildRow[]) =>
  fittingOrder(
    children.map((child) => ({
      itemId: String(child.item_id),
      typeId: Number(child.type_id),
      flag: child.location_flag,
      quantity: child.quantity,
    }))
  )

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
  if (!user) redirect('/')

  // The ship row, from whichever hangar owns it. Both hangars are probed at
  // once and the character row wins: an item lives in exactly one of them, so
  // the corp lookup is a cheap indexed miss rather than a second round trip
  // waiting on the first to come back empty.
  const [{ data: characterSelf }, { data: corpSelf }] = await Promise.all([
    supabase
      .from('character_asset')
      .select('item_id, registration_id, type_id, name')
      .eq('item_id', itemId)
      .maybeSingle<ShipRow>(),
    supabase.from('corp_asset').select('item_id, corporation_id, type_id').eq('item_id', itemId).maybeSingle<ShipRow>(),
  ])
  const self = characterSelf ?? corpSelf
  if (!self) notFound()

  // One process-cached SDE read answers both questions this page opens with:
  // whether the id is a ship at all, and what to call it.
  const selfType = await getSdeType(Number(self.type_id))
  // Non-ships (containers, loose stacks) live on the asset browser instead.
  if (selfType?.categoryID !== SHIP_CATEGORY_ID) redirect(`/asset/${itemId}`)

  const [{ data: characterChildren }, { data: corpChildren }, crumbs, owner, shareData] = await Promise.all([
    supabase
      .from('character_asset')
      .select('item_id, registration_id, type_id, location_flag, quantity, is_singleton, is_blueprint_copy, name')
      .eq('location_id', itemId),
    supabase
      .from('corp_asset')
      .select('item_id, corporation_id, type_id, location_flag, quantity, is_singleton, is_blueprint_copy')
      .eq('location_id', itemId),
    // The full container chain up to its station / structure / system,
    // rendered as the breadcrumb above the heading.
    fetchAssetPath(itemId, supabase),
    fetchShipOwner(supabase, characterSelf, corpSelf),
    // The share dialog appears only for a character item the caller actually
    // owns — RLS visibility alone can also mean "shared with me", which must
    // not offer the dialog.
    fetchShareDialogData(supabase, itemId),
  ])
  const children = [...((characterChildren ?? []) as ChildRow[]), ...((corpChildren ?? []) as ChildRow[])]
  const rows = fitRows(children)

  // Names and categories for the EFT export: the hull (already cached by the
  // lookup above) plus everything fitted or aboard.
  const types = eftTypes(await getSdeTypes([Number(self.type_id), ...rows.map((row) => row.typeId)]))

  const typeName = selfType?.name ?? `#${self.type_id}`

  return (
    <>
      <AssetPath crumbs={crumbs} current={self.name ?? typeName} />
      <ShipIdentity
        name={self.name && self.name !== typeName ? self.name : typeName}
        typeName={typeName}
        groupName={selfType?.groupName ?? null}
        itemId={itemId}
        owner={owner}
        location={locationLabel(crumbs)}
        actions={
          <>
            {/* The hull plus everything nested inside it — the same set the
                bays and the table below list, priced in one request. */}
            <AppraisalPanel targets={[itemId]} label="Appraise" />
            {/* The same rows, as the text the game imports. */}
            <FitExport eft={shipEft(Number(self.type_id), self.name ?? null, rows, types)} />
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
      <ShipViewDynamic esiFit={toEsiFit(Number(self.type_id), self.name ?? null, rows)} />
      <Suspense fallback={<ContentsFallback />}>
        <ShipContents
          supabase={supabase}
          itemId={itemId}
          self={self}
          ownerId={characterSelf?.registration_id ?? String(corpSelf?.corporation_id)}
          childRows={children}
        />
      </Suspense>
    </>
  )
}

// While the subtree walk behind the table's nested counts is in flight. The
// viewer above it is already drawn, so this stands in for the table alone.
const ContentsFallback = () => (
  <SkeletonTable
    columns={['Quantity', 'Item', 'Volume (m³)', 'Group', 'Category', 'Owner', 'Hangar', 'Contents']}
    numeric={['Quantity', 'Volume (m³)', 'Contents']}
    rows={8}
  />
)

// Anonymous share-link view: the viewer, the ship's identity and its contents,
// with no breadcrumb and no location. All queries run on the service client,
// explicitly filtered to the sharer's characters/corps. Accepts both link
// generations — the signed ?share= param (recursive over the shared subtree)
// and the legacy ?token= (exact id).
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
  if (!self) notFound()
  const selfType = await getSdeType(Number(self.type_id))
  // The share outlived the ship (sold, transferred, unlinked): dead link.
  if (selfType?.categoryID !== SHIP_CATEGORY_ID) notFound()

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

  const typeName = selfType?.name ?? `#${self.type_id}`
  const rows = fitRows(children)

  return (
    <>
      {shareParams.share && <ShareUrlCleanup />}
      <ShipIdentity
        name={self.name && self.name !== typeName ? self.name : typeName}
        typeName={typeName}
        groupName={selfType?.groupName ?? null}
        itemId={itemId}
        owner={owner}
        // A share link says what the ship is, never where it is.
        location={null}
      />
      <ShipViewDynamic esiFit={toEsiFit(Number(self.type_id), self.name ?? null, rows)} />
      {/* The same table the owner sees, minus the drill-down: a nested
          container would need a share token of its own to open. */}
      <SharedShipContents
        self={self}
        owner={{
          id: ownerId,
          name: owner.name,
          kind: characterSelf?.registration_id ? 'character' : 'corporation',
        }}
        childRows={children}
      />
    </>
  )
}

export default ShipPage
