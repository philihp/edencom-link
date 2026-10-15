import { uniq } from 'ramda'
import { cache } from 'react'

import { getHullPricesByName } from '@/hullPrices'
import { getSdeTypes } from '@/sdeTypes'
import { createServiceClient } from '@/utils/supabase/service'

import { toAppraisalLines } from '../../../../api/appraisal/assetLines'
import { capturedLines } from '../../../../api/appraisal/capturedPrices'
import { applyHullPrices } from '../../../../api/appraisal/pricedLines'
import { cardRows, cardValue, metaColor, type CardChild } from '../../../../ship/[itemId]/card/cardModel'
import { PRICE_MARKET, type ShipCard } from '../../../../ship/[itemId]/card/loadCard'
import { characterPortrait } from '../../../../ship/[itemId]/shipHeading'
import { verifySignedFittingShare } from '../../../access'
import type { FittingRow } from '../../../fit'
import { resolveFittingOwner } from '../../../resolveCharacter'
import { fittingDescription } from './cardModel'

// Everything the link-preview card says about a saved fitting a signed share
// link opens: the hull, the fit slot by slot, who saved it and what it costs
// at Jita. The page's generateMetadata and the image route both read it, so
// the preview never shows more than the link opens.
//
// Only a signed ?share= link gets a card. A chat client fetching a preview is
// signed out, and every other way to see someone's fit (a corporation,
// alliance or public share) needs a session, which the page asks for too.
//
// Prices are our own hourly Jita capture, never the appraisal provider: its
// request budget is deployment-wide, and a chat client must not spend it.
export const loadFittingCard = cache(
  async (characterId: string, fittingId: string, share?: string): Promise<ShipCard | null> => {
    if (!share) return null
    const service = createServiceClient()
    // The service client reads every registration, so this resolves the URL's
    // character to its registration whoever asks. The signature check below is
    // what decides whether the link opens anything.
    const owner = await resolveFittingOwner(service, characterId)
    if (!owner || !(await verifySignedFittingShare(share, owner.registrationId, fittingId))) return null

    const { data: fit } = await service
      .from('character_fitting')
      .select('registration_id, fitting_id, name, description, ship_type_id, items')
      .eq('registration_id', owner.registrationId)
      .eq('fitting_id', fittingId)
      .maybeSingle<FittingRow>()
    if (!fit) return null

    const hullTypeId = Number(fit.ship_type_id)
    const children: CardChild[] = (fit.items ?? []).map((item) => ({
      typeId: Number(item.type_id),
      flag: item.flag,
      quantity: Number(item.quantity ?? 1) || 1,
    }))
    const types = await getSdeTypes(uniq([hullTypeId, ...children.map((child) => child.typeId)]))

    // The hull and every item of the fit, priced as the ship card prices a
    // hull and its contents, with Chancellor-set hull prices in place.
    const quantities = [{ typeId: hullTypeId, quantity: 1 }, ...children].reduce(
      (tally, { typeId, quantity }) => tally.set(typeId, (tally.get(typeId) ?? 0) + quantity),
      new Map<number, number>()
    )
    const { lines } = toAppraisalLines(quantities, types)
    const priced = applyHullPrices(await capturedLines(lines, types, PRICE_MARKET), await getHullPricesByName())

    const hull = types[hullTypeId]
    const typeName = hull?.name ?? `#${hullTypeId}`
    const groupName = hull?.groupName ?? null
    const pilot = { name: owner.name ?? 'Unknown character', portrait: characterPortrait(owner.characterId) }
    const rows = cardRows(children, types)
    const value = cardValue(priced)
    return {
      hullTypeId,
      title: fit.name || `Fitting #${fit.fitting_id}`,
      typeName,
      groupName,
      color: metaColor(hull?.metaGroupID),
      owner: pilot,
      rows,
      value,
      sighting: null,
      description: fittingDescription(typeName, groupName, pilot.name, rows, value),
    }
  }
)
