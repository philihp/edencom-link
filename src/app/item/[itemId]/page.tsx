import { notFound, redirect } from 'next/navigation'

import { FIT_UI_FLAG, hasFlag } from '@/flags'
import { getSdeType, getSdeTypes } from '@/sdeTypes'
import { createClient } from '@/utils/supabase/server'

import { establishedUser } from '../../account/lib/establishedUser'
import { AppraisalPanel } from '../../asset/[locationId]/appraisalPanel'
import { AssetPath, fetchAssetPath, type Crumb } from '../../assetPath'
import { toEsiFit } from '../../ship/[itemId]/esfFit'
import { fetchShipOwner } from '../../ship/[itemId]/shipOwner'
import { SHIP_CATEGORY_ID, fittingOrder } from '../../ship/[itemId]/shipRows'
import { eftTypes, shipEft } from './eft'
import { FitExport } from './fitExport'
import { ShipIdentity } from './identity'
import { ShipViewDynamic } from './shipViewDynamic'

// The ship viewer built on our own fitting stack — stages 2 and 3 of
// docs/custom-fit-ui.md. Same ship /ship/[itemId] renders, same rows, same
// dogma model; what's different is that every pixel of the fit is ours rather
// than @eveshipfit/react's embed, which is what lets it be laid out for a
// phone as well as a desktop.
//
// Still dark-launched: nothing links here, and the `fit-ui` flag gates it, so
// obscurity isn't the only gate. Access is otherwise exactly /ship's signed-in
// path — the same RLS-scoped queries, so this route can't see a ship its owner
// couldn't. The share-token path is deliberately not mirrored: an unreleased
// page has no business being anonymously reachable.

type ShipRow = {
  item_id: number | string
  type_id: number | string
  name: string | null
  registration_id?: string
  corporation_id?: number | string
}

// A row inside the ship: a fitted module, its ammunition, a drone, or cargo.
type FittedRow = {
  item_id: number | string
  type_id: number | string
  location_flag: string | null
  quantity: number | string | null
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

const ItemFitPage = async ({ params }: { params: Promise<{ itemId: string }> }) => {
  const { itemId } = await params

  const supabase = await createClient()
  const user = await establishedUser(supabase)
  if (!user) redirect('/')
  // A visitor without the flag gets the same answer as a visitor to a route
  // that doesn't exist.
  if (!(await hasFlag(user.id, FIT_UI_FLAG))) notFound()

  // Both hangars probed at once, character wins — the same shape /ship uses.
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

  const selfType = await getSdeType(Number(self.type_id))
  if (selfType?.categoryID !== SHIP_CATEGORY_ID) notFound()

  const [{ data: characterChildren }, { data: corpChildren }, crumbs, owner] = await Promise.all([
    supabase
      .from('character_asset')
      .select('item_id, type_id, location_flag, quantity')
      .eq('location_id', itemId)
      .returns<FittedRow[]>(),
    supabase
      .from('corp_asset')
      .select('item_id, type_id, location_flag, quantity')
      .eq('location_id', itemId)
      .returns<FittedRow[]>(),
    // The full container chain up to its station / structure / system.
    fetchAssetPath(itemId, supabase),
    fetchShipOwner(supabase, characterSelf, corpSelf),
  ])
  const children = [...(characterChildren ?? []), ...(corpChildren ?? [])]

  // The same rows /ship feeds its viewer, in the same fitting-window order, so
  // the two pages are demonstrably looking at one fit. Only the four fields
  // toEsiFit reads are built — the rest of an ItemRow describes a table this
  // page doesn't render.
  const rows = fittingOrder(
    children.map((child) => ({
      itemId: String(child.item_id),
      typeId: Number(child.type_id),
      flag: child.location_flag,
      quantity: child.quantity,
    }))
  )

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
                bays below list, priced in one request. */}
            <AppraisalPanel targets={[itemId]} label="Appraise" />
            {/* The same rows, as the text the game imports. */}
            <FitExport eft={shipEft(Number(self.type_id), self.name ?? null, rows, types)} />
          </>
        }
      />
      <ShipViewDynamic esiFit={toEsiFit(Number(self.type_id), self.name ?? null, rows)} />
    </>
  )
}

export default ItemFitPage
