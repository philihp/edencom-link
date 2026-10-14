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
import { resolveShareParams } from '../../access'
import { fetchRootItems, SHIP_CATEGORY_ID } from '../locationData'
import { type ContainerChild, containerDescription, containerStacks, type StackIcon } from './cardModel'

// Everything the link-preview card says about a container a share link opens:
// what it is, whose it is, and what is directly inside it. The page's
// generateMetadata and the image route both read it, so the preview never
// shows more than the link opens.
//
// The service-role client bypasses RLS, so every query is filtered to the
// share scope's registrations/corporations, exactly as the share page is.
// Nothing reads a location: a share link says what the container holds, never
// where it is.
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
  typeId: number
  // The artwork the image server holds for the container's own type.
  variation: IconVariation
  // The container's own name where the owner gave it one, else the type's.
  title: string
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
    const { data: registration } = await supabase
      .from('registration')
      .select('character_id')
      .eq('id', self.registration_id)
      .maybeSingle<{ character_id: number | string | null }>()
    return {
      owner: {
        name: holderName ?? 'Unknown character',
        portrait: registration?.character_id == null ? null : characterPortrait(registration.character_id),
      },
      hideName: (name) => name ?? null,
    }
  }
  const corporationId = Number(self.corporation_id)
  const { data: corpName } = await supabase
    .from('universe_name')
    .select('name')
    .eq('id', corporationId)
    .maybeSingle<{ name: string }>()
  return {
    owner: { name: corpName?.name ?? `Corporation #${corporationId}`, portrait: corporationLogo(corporationId) },
    hideName: (name) => name ?? null,
  }
}

// The card for a container (any item that is not a ship) a share link opens,
// or null: the link opens nothing, names a bare place rather than an item, or
// names a ship — the ship page has its own card. Cached per request, since the
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
    if (!self) return null

    const typeId = Number(self.type_id)
    // A ship has its own page and card; this card is for everything else.
    const selfType = await getSdeType(typeId)
    if (selfType?.categoryID === SHIP_CATEGORY_ID) return null

    const { rootItems } = await fetchRootItems(supabase, itemId, scope.registrationIds, corpScope)
    const children: ContainerChild[] = rootItems.map((item) => ({
      typeId: Number(item.type_id),
      quantity: item.is_singleton ? 1 : Number(item.quantity ?? 1) || 1,
      isBlueprintCopy: item.is_blueprint_copy,
    }))
    const [types, hullPrices, presented] = await Promise.all([
      getSdeTypes([...new Set([typeId, ...children.map((child) => child.typeId)])]),
      getHullPricesByName(),
      presentedOwner(
        supabase,
        self,
        self.registration_id ? (scope.characterNames.get(self.registration_id) ?? null) : null,
        scope.showAsMain
      ),
    ])
    // The container and everything directly inside it, priced as the page's
    // appraisal would (blueprints left out), with hull prices in place.
    const quantities = [{ typeId, quantity: 1 }, ...children].reduce(
      (tally, { typeId: id, quantity }) => tally.set(id, (tally.get(id) ?? 0) + quantity),
      new Map<number, number>()
    )
    const { lines } = toAppraisalLines(quantities, types)
    const priced = applyHullPrices(await capturedLines(lines, types, PRICE_MARKET), hullPrices)
    const unitSell = new Map(priced.map((line) => [line.name, line.sell]))

    const typeName = selfType?.name ?? `#${typeId}`
    const groupName = selfType?.groupName ?? null
    const name = presented.hideName(self.name)
    const value = cardValue(priced)
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
