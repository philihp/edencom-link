import { uniq } from 'ramda'
import { cache } from 'react'

import { getHullPricesByName } from '@/hullPrices'
import { getSdeType, getSdeTypes } from '@/sdeTypes'
import { createServiceClient } from '@/utils/supabase/service'

import { iconVariation, type IconVariation } from '../../../iconVariation'
import { toAppraisalLines } from '../../../api/appraisal/assetLines'
import { capturedLines } from '../../../api/appraisal/capturedPrices'
import { applyHullPrices } from '../../../api/appraisal/pricedLines'
import { cardValue, metaColor, type CardValue } from '../../../ship/[itemId]/card/cardModel'
import { PRICE_MARKET } from '../../../ship/[itemId]/card/loadCard'
import { mainOwnerOf } from '../../../ship/[itemId]/mainOwner'
import { UNNAMED_OWNER, withoutHolderName } from '../../../ship/[itemId]/presentedOwner'
import { characterPortrait, corporationLogo, type ShipOwner } from '../../../ship/[itemId]/shipHeading'
import { resolveShareParams, type ShareScope } from '../../access'
import { type Asset, fetchRootItems, SHIP_CATEGORY_ID } from '../locationData'
import { fetchPlace } from '../placeHeading'
import {
  type ContainerChild,
  containerDescription,
  containerStacks,
  PLACE_KIND_NAME,
  placeDescription,
  type StackIcon,
} from './cardModel'

// Everything the link-preview card says about a container a share link opens:
// what it is, whose it is, and what is directly inside it. The page's
// generateMetadata and the image route both read it, so the preview never
// shows more than the link opens.
//
// The service-role client bypasses RLS, so every query is filtered to the
// share scope's registrations/corporations, exactly as the share page is.
// Nothing reads a location: a share link says what the container holds, never
// where it is. The one exception is a place share
// (docs/sharing-layer/15-place-share.md), whose subject IS the place: its card
// names the station, structure or system, as its page does, and shows what the
// sharer holds there.
//
// The contents are the container's direct children — what the share page
// lists. EVE will not put a container holding anything into another
// container, nor an assembled ship into one, so one level is the whole
// container in all but rare cases (a container's own nested bays).
//
// Prices are our own hourly Jita capture, never the appraisal provider: the
// provider's request budget is deployment-wide, and a chat client fetching a
// preview must not spend it.

export type AssetCard = {
  // The container's own type, or a structure's; null for a station or a solar
  // system, which the card draws without a picture.
  typeId: number | null
  // The artwork the image server holds for that type.
  variation: IconVariation
  // The container's own name where the owner gave it one, else the type's. A
  // place's name.
  title: string
  // For a place, what kind of place it is; groupName is then its system.
  typeName: string
  groupName: string | null
  color: string
  owner: ShipOwner
  stacks: StackIcon[]
  itemCount: number
  value: CardValue
  description: string
}

type SelfRow = {
  item_id: number | string
  type_id: number | string
  name?: string | null
  registration_id?: string
  corporation_id?: number | string
  is_blueprint_copy: boolean | null
}

const characterOwner = async (
  supabase: ReturnType<typeof createServiceClient>,
  registrationId: string,
  name: string | null
): Promise<ShipOwner> => {
  const { data: registration } = await supabase
    .from('registration')
    .select('character_id')
    .eq('id', registrationId)
    .maybeSingle<{ character_id: number | string | null }>()
  return {
    name: name ?? 'Unknown character',
    portrait: registration?.character_id == null ? null : characterPortrait(registration.character_id),
  }
}

const corporationOwner = async (
  supabase: ReturnType<typeof createServiceClient>,
  corporationId: number
): Promise<ShipOwner> => {
  const { data: corpName } = await supabase
    .from('universe_name')
    .select('name')
    .eq('id', corporationId)
    .maybeSingle<{ name: string }>()
  return { name: corpName?.name ?? `Corporation #${corporationId}`, portrait: corporationLogo(corporationId) }
}

// Who the card names as the owner, and the name filter the share asks for.
// A character share with show_as_main draws the account's main and hides the
// holder (presentedOwner.ts); a corporation is always its own owner.
const presentedOwner = async (
  supabase: ReturnType<typeof createServiceClient>,
  self: SelfRow,
  holderName: string | null,
  showAsMain: boolean
): Promise<{ owner: ShipOwner; hideName: (name: string | null | undefined) => string | null }> => {
  if (self.registration_id) {
    const main = showAsMain ? await mainOwnerOf(self.registration_id) : null
    if (showAsMain && !main?.isHolder) {
      return { owner: main?.owner ?? UNNAMED_OWNER, hideName: withoutHolderName(holderName) }
    }
    return { owner: await characterOwner(supabase, self.registration_id, holderName), hideName: (name) => name ?? null }
  }
  return {
    owner: await corporationOwner(supabase, Number(self.corporation_id)),
    hideName: (name) => name ?? null,
  }
}

// Who a place card names as the owner. A corporation's place share is the
// corporation's. An account's names every character the account holds
// something with there (the page lists them all): one holder is named, several
// are the account's main, else the first of them.
const placeOwner = async (
  supabase: ReturnType<typeof createServiceClient>,
  scope: ShareScope,
  rootItems: Asset[]
): Promise<ShipOwner> => {
  if (scope.registrationIds.length === 0) return corporationOwner(supabase, scope.corporationIds[0])
  const holders = uniq(rootItems.map((item) => item.owner_id))
  const first = holders[0] ?? scope.registrationIds[0]
  const main = holders.length === 1 ? null : await mainOwnerOf(first)
  return main?.owner ?? characterOwner(supabase, first, scope.characterNames.get(first) ?? null)
}

// Children as the card counts them: one entry per row the share page lists.
const toChildren = (rootItems: Asset[]): ContainerChild[] =>
  rootItems.map((item) => ({
    typeId: Number(item.type_id),
    quantity: item.is_singleton ? 1 : Number(item.quantity ?? 1) || 1,
    isBlueprintCopy: item.is_blueprint_copy,
  }))

// The lot priced as the page's appraisal would (blueprints left out), with
// hull prices in place, plus the unit sell price per type name.
const priceLot = async (quantities: Map<number, number>, types: Awaited<ReturnType<typeof getSdeTypes>>) => {
  const { lines } = toAppraisalLines(quantities, types)
  const priced = applyHullPrices(await capturedLines(lines, types, PRICE_MARKET), await getHullPricesByName())
  return { value: cardValue(priced), unitSell: new Map(priced.map((line) => [line.name, line.sell])) }
}

const tally = (entries: Array<{ typeId: number; quantity: number }>): Map<number, number> =>
  entries.reduce(
    (acc, { typeId, quantity }) => acc.set(typeId, (acc.get(typeId) ?? 0) + quantity),
    new Map<number, number>()
  )

// The card for a place share: the station, structure or solar system, whose
// assets these are, and what the sharer holds there directly (a system's items
// in space, as its share page lists them). Null when the id is no place we
// know, so a link to anything else unfurls nothing rather than a blank card.
const loadPlaceCard = async (
  supabase: ReturnType<typeof createServiceClient>,
  placeId: string,
  scope: ShareScope,
  corpScope: number[]
): Promise<AssetCard | null> => {
  const { rootItems } = await fetchRootItems(supabase, placeId, scope.registrationIds, corpScope)
  const place = await fetchPlace(supabase, placeId, corpScope, rootItems[0]?.location_type ?? null)
  if (place.kind == null) return null

  const children = toChildren(rootItems)
  const [types, owner] = await Promise.all([
    getSdeTypes(uniq(children.map((child) => child.typeId))),
    placeOwner(supabase, scope, rootItems),
  ])
  const { value, unitSell } = await priceLot(tally(children), types)
  const typeName = PLACE_KIND_NAME[place.kind]
  return {
    typeId: place.structureTypeId,
    variation: 'icon',
    title: place.heading,
    typeName,
    groupName: place.isSolarSystem ? null : (place.systemName ?? null),
    color: metaColor(null),
    owner,
    stacks: containerStacks(children, types, (line) => unitSell.get(line) ?? null),
    itemCount: children.length,
    value,
    description: placeDescription(place.heading, place.kind, owner.name, children.length, value),
  }
}

// The card for a container (any item that is not a ship) or a place a share
// link opens, or null: the link opens nothing, or names a ship — the ship page
// has its own card. Cached per request, since the
// page's metadata and viewport both ask.
export const loadAssetCard = cache(
  async (itemId: string, share?: string, token?: string): Promise<AssetCard | null> => {
    const scope = await resolveShareParams({ share, token }, itemId)
    if (!scope) return null

    const supabase = createServiceClient()
    const corpScope = scope.corporationIds.length > 0 ? scope.corporationIds : [-1]
    const [{ data: characterSelf }, { data: corpSelf }] = await Promise.all([
      supabase
        .from('character_asset')
        .select('item_id, registration_id, type_id, name, is_blueprint_copy')
        .eq('item_id', itemId)
        .in('registration_id', scope.registrationIds)
        .maybeSingle<SelfRow>(),
      supabase
        .from('corp_asset')
        .select('item_id, corporation_id, type_id, is_blueprint_copy')
        .eq('item_id', itemId)
        .in('corporation_id', corpScope)
        .maybeSingle<SelfRow>(),
    ])
    const self = characterSelf ?? corpSelf
    if (!self) return loadPlaceCard(supabase, itemId, scope, corpScope)

    const typeId = Number(self.type_id)
    // A ship has its own page and card; this card is for everything else.
    const selfType = await getSdeType(typeId)
    if (selfType?.categoryID === SHIP_CATEGORY_ID) return null

    const { rootItems } = await fetchRootItems(supabase, itemId, scope.registrationIds, corpScope)
    const children = toChildren(rootItems)
    const [types, presented] = await Promise.all([
      getSdeTypes(uniq([typeId, ...children.map((child) => child.typeId)])),
      presentedOwner(
        supabase,
        self,
        self.registration_id ? (scope.characterNames.get(self.registration_id) ?? null) : null,
        scope.showAsMain
      ),
    ])
    // The container and everything directly inside it.
    const { value, unitSell } = await priceLot(tally([{ typeId, quantity: 1 }, ...children]), types)

    const typeName = selfType?.name ?? `#${typeId}`
    const groupName = selfType?.groupName ?? null
    const name = presented.hideName(self.name)
    return {
      typeId,
      variation: iconVariation(selfType?.categoryID, self.is_blueprint_copy),
      title: name && name !== typeName ? name : typeName,
      typeName,
      groupName,
      color: metaColor(selfType?.metaGroupID),
      owner: presented.owner,
      stacks: containerStacks(children, types, (line) => unitSell.get(line) ?? null),
      itemCount: children.length,
      value,
      description: containerDescription(typeName, groupName, presented.owner.name, children.length, value),
    }
  }
)
