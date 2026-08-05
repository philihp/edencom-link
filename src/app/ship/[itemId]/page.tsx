import { notFound, redirect } from 'next/navigation'
import { ascend, sortWith } from 'ramda'

import { getSdeType, getSdeTypes } from '@/sdeTypes'
import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { AssetPath, fetchAssetPath } from '../../assetPath'
import { typeFacts } from '../../assetTypeFacts'
import { fetchOwners } from '../../owners'
import type { Owners } from '../../ownerFilter'
import { fetchTypeNames } from '../../typeNames'
import { flagSortKey } from '../../fitting/fit'
import { LocationAssets, type ItemRow } from '../../asset/[locationId]/locationAssets'
import { resolveShareParams } from '../../asset/access'
import { fetchShareDialogData } from '../../asset/shareData'
import { ShareDialog } from '../../asset/shareDialog'
import { toEsiFit } from './esfFit'
import { characterPortrait, corporationLogo, ShipHeading, type ShipOwner } from './shipHeading'
import { ShipFitViewDynamic } from './shipFitViewDynamic'

// invGroups.categoryID for the Ship category in CCP's SDE.
const SHIP_CATEGORY_ID = 6

type ShipRow = {
  item_id: number | string
  type_id: number | string
  location_id: number | string | null
  location_type: string | null
  name: string | null
  registration_id?: string
  corporation_id?: number | string
}

type ChildRow = {
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

// Whether a single type is in the Ship category — one SDE lookup, for the
// self-type gate that decides ship page vs asset browser.
const isShipType = async (typeId: number | string): Promise<boolean> =>
  (await getSdeType(Number(typeId)))?.categoryID === SHIP_CATEGORY_ID

// Fitting-window order for the module table: slot family first (high → mid →
// low → rigs → bays, via the same flagSortKey the fitting pages use), the flag
// string within a family (HiSlot0 before HiSlot1), then type id. This is the
// server order the unsorted table shows, so the listing reads top-to-bottom
// the way the ship does.
const fittingOrder = sortWith<ItemRow>([
  ascend((r) => flagSortKey(r.flag ?? '')),
  ascend((r) => r.flag ?? ''),
  ascend((r) => r.typeId),
])

// A ship's own page: the eveship.fit wheel + stats built from its fitted
// modules, a full module/cargo table in fitting order (the same sortable
// LocationAssets table the asset browser uses), owner and location. Reachable
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
  const { data: auth, error: authError } = await supabase.auth.getUser()
  if (authError || !auth?.user) {
    redirect('/')
  }

  // The ship row, from whichever hangar owns it.
  const { data: characterSelf } = await supabase
    .from('character_asset')
    .select('item_id, registration_id, type_id, location_id, location_type, name')
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
      .select('item_id, registration_id, type_id, location_flag, quantity, is_singleton, is_blueprint_copy, name')
      .eq('location_id', itemId),
    supabase
      .from('corp_asset')
      .select('item_id, corporation_id, type_id, location_flag, quantity, is_singleton, is_blueprint_copy')
      .eq('location_id', itemId),
  ])
  const children = [...((characterChildren ?? []) as ChildRow[]), ...((corpChildren ?? []) as ChildRow[])]

  // Nested-contents counts drive the drill-in links on container/ship rows.
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

  // Owner: the holding character's name and portrait, or the corporation's
  // cached name and logo. `character_id` here is the EVE numeric id (what the
  // image server serves portraits for), not the registration uuid its
  // sibling asset columns misname.
  let owner: ShipOwner
  if (characterSelf?.registration_id) {
    const { data: registration } = await supabase
      .from('registration')
      .select('name, character_id')
      .eq('id', characterSelf.registration_id)
      .maybeSingle<{ name: string; character_id: number | string | null }>()
    // A shared ship's owner is outside the caller's registration view (RLS);
    // their public name resolves through the world-readable directory.
    const { data: directory } = registration
      ? { data: null }
      : await supabase
          .from('character_directory')
          .select('name, character_id')
          .eq('registration_id', characterSelf.registration_id)
          .maybeSingle<{ name: string | null; character_id: number | string | null }>()
    const eveCharacterId = registration?.character_id ?? directory?.character_id ?? null
    owner = {
      name: registration?.name ?? directory?.name ?? 'Unknown character',
      portrait: eveCharacterId == null ? null : characterPortrait(eveCharacterId),
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

  // The share dialog appears only for a character item the caller actually
  // owns — with phase 2's widening policy, RLS visibility alone can also mean
  // "shared with me", which must not offer the dialog.
  const [shareData, owners] = await Promise.all([fetchShareDialogData(supabase, itemId), fetchOwners()])

  return (
    <>
      <AssetPath crumbs={crumbs} current={heading} />
      <ShipHeading
        typeId={Number(self.type_id)}
        heading={heading}
        owner={owner}
        actions={shareData ? <ShareDialog itemId={itemId} path="ship" data={shareData} /> : null}
      />
      <ShipFitViewDynamic esiFit={toEsiFit(Number(self.type_id), self.name ?? null, rows)} />
      <LocationAssets rows={rows} owners={owners} typeNamesPromise={typeNamesPromise} canAppraise />
    </>
  )
}

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
  if (!self || !(await isShipType(self.type_id))) notFound()

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

  const typeNamesPromise = fetchTypeNames(children.map((c) => Number(c.type_id)))
  // The same bulk lookup the signed-in view does, for the volume/group/category
  // columns and each row's icon variation. Pure SDE data — public-read, nothing
  // owner-specific — so it's as safe on the share path as the type names are.
  const childTypes = await getSdeTypes(children.map((c) => Number(c.type_id)))
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
      <ShipHeading typeId={Number(self.type_id)} heading={heading} owner={owner} />
      <ShipFitViewDynamic esiFit={toEsiFit(Number(self.type_id), self.name ?? null, rows)} />
      <LocationAssets rows={rows} owners={owners} typeNamesPromise={typeNamesPromise} canAppraise={false} />
    </>
  )
}

export default ShipPage
