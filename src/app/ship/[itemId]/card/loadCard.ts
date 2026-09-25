import { after } from 'next/server'
import { cache } from 'react'

import { getHullPricesByName } from '@/hullPrices'
import { appraise } from '@/innominate'
import { getSdeTypes, type SdeType } from '@/sdeTypes'
import { sdeSupabase } from '@/utils/supabase/sde'

import { toAppraisalLines, type AppraisalLine } from '../../../api/appraisal/assetLines'
import { applyHullPrices, fromAppraisal, type PricedLine } from '../../../api/appraisal/pricedLines'
import { readShipAppraisal, writeShipAppraisal } from '../../../api/appraisal/shipAppraisal'
import type { ShipOwner } from '../shipHeading'
import { sharedShip } from '../sharedShip'
import {
  type CardChild,
  cardDescription,
  cardRows,
  cardValue,
  type CardRow,
  type CardValue,
  metaColor,
} from './cardModel'

// The market the card prices against, the same default the Appraise button
// uses. Jita is the one every player reads a number in.
const PRICE_MARKET = 'jita'

// How long a stored appraisal (ship_appraisal) stands before the card asks
// the provider again. The extract jobs refresh a ship's contents every 6h, so
// a fresher price than that would price a fit we may not have yet.
const APPRAISAL_MAX_AGE_MS = 6 * 60 * 60 * 1000

// How long the card waits for a new appraisal before it draws with what it
// has. The provider's queue can hold a request for most of a minute, and a
// chat client fetching a preview will not wait that long. The request goes on
// after the response (next/server after()), so the next card has its answer.
const APPRAISAL_WAIT_MS = 8000

export type ShipCard = {
  hullTypeId: number
  // The ship's own name where the owner gave it one, else the hull's.
  title: string
  typeName: string
  groupName: string | null
  color: string
  owner: ShipOwner
  rows: CardRow[]
  value: CardValue
  description: string
}

// Our own hourly Jita capture, per appraisal line. Only the last resort: the
// card uses it when no appraisal of the ship has come in yet.
const capturedLines = async (lines: AppraisalLine[], types: Record<number, SdeType>): Promise<PricedLine[]> => {
  const idByName = new Map(Object.values(types).map((type) => [type.name, type.typeID]))
  const ids = lines.flatMap((line) => {
    const id = idByName.get(line.name)
    return id == null ? [] : [id]
  })
  const { data, error } = await sdeSupabase()
    .from('market_price')
    .select('type_id, sell_min, buy_max')
    .eq('market', PRICE_MARKET)
    .in('type_id', ids)
  if (error) console.error(`[shipCard] prices failed: ${error.message}`)
  const byId = new Map(
    ((data ?? []) as Array<{ type_id: number; sell_min: number | string | null; buy_max: number | string | null }>).map(
      (row) => [Number(row.type_id), row]
    )
  )
  return lines.map((line) => {
    const row = byId.get(idByName.get(line.name) ?? -1)
    return {
      name: line.name,
      quantity: line.quantity,
      sell: row?.sell_min == null ? null : Number(row.sell_min),
      buy: row?.buy_max == null ? null : Number(row.buy_max),
    }
  })
}

// A new appraisal from the provider, stored for the next card. Null when the
// provider refuses or is not configured.
const appraiseShip = async (itemId: string, lines: AppraisalLine[]): Promise<PricedLine[] | null> => {
  const result = await appraise(lines, PRICE_MARKET, false)
  if (!result.ok) return null
  const priced = fromAppraisal(lines, result.appraisal.items)
  await writeShipAppraisal(itemId, PRICE_MARKET, priced)
  return priced
}

const within = <T>(promise: Promise<T>, ms: number): Promise<T | undefined> =>
  Promise.race([promise, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms))])

// The ship's lines with unit prices, before hull prices. In order of trust:
// the stored appraisal while it is fresh; a new one, when the caller may ask
// the provider and it answers in time; a stale stored one; our own capture.
//
// Only the image route passes mayAppraise. The page's metadata reads what is
// stored and never asks: every view of a share link renders it, and the card
// is what a chat client fetches.
const pricedLines = async (
  itemId: string,
  lines: AppraisalLine[],
  types: Record<number, SdeType>,
  mayAppraise: boolean
): Promise<PricedLine[]> => {
  const stored = await readShipAppraisal(itemId)
  const fresh = stored != null && Date.now() - new Date(stored.appraisedAt).getTime() < APPRAISAL_MAX_AGE_MS
  if (fresh) return stored.lines
  if (mayAppraise && lines.length > 0) {
    const pending = appraiseShip(itemId, lines).catch((error: unknown) => {
      console.error(`[shipCard] appraisal failed: ${error instanceof Error ? error.message : String(error)}`)
      return null
    })
    const answer = await within(pending, APPRAISAL_WAIT_MS)
    if (answer) return answer
    // Not in time: let it finish after the response, so the next card has it.
    if (answer === undefined) after(() => pending)
  }
  return stored?.lines ?? capturedLines(lines, types)
}

// The card for a ship a share link opens, or null when the link opens
// nothing. Only reached with share parameters: the card must never show a
// ship that its link does not. Cached per request, because the page's
// metadata and viewport both ask for it.
export const loadShipCard = cache(
  async (itemId: string, share?: string, token?: string, mayAppraise = false): Promise<ShipCard | null> => {
    const ship = await sharedShip(itemId, share, token)
    if (!ship) return null

    const hullTypeId = Number(ship.self.type_id)
    const children: CardChild[] = ship.children.map((child) => ({
      typeId: Number(child.type_id),
      flag: child.location_flag,
      quantity: Number(child.quantity ?? 1) || 1,
    }))
    const typeIds = [...new Set([hullTypeId, ...children.map((child) => child.typeId)])]
    const [types, hullPrices] = await Promise.all([getSdeTypes(typeIds), getHullPricesByName()])

    // The hull and everything directly inside it — what the share page lists —
    // as the name-keyed lines the provider prices, blueprints left out.
    const quantities = [{ typeId: hullTypeId, quantity: 1 }, ...children].reduce(
      (tally, { typeId, quantity }) => tally.set(typeId, (tally.get(typeId) ?? 0) + quantity),
      new Map<number, number>()
    )
    const { lines } = toAppraisalLines(quantities, types)
    const priced = applyHullPrices(await pricedLines(itemId, lines, types, mayAppraise), hullPrices)

    const typeName = ship.selfType?.name ?? `#${hullTypeId}`
    const groupName = ship.selfType?.groupName ?? null
    const rows = cardRows(children, types)
    const value = cardValue(priced)
    return {
      hullTypeId,
      title: ship.self.name && ship.self.name !== typeName ? ship.self.name : typeName,
      typeName,
      groupName,
      color: metaColor(ship.selfType?.metaGroupID),
      owner: ship.owner,
      rows,
      value,
      description: cardDescription(typeName, groupName, ship.owner.name, rows, value),
    }
  }
)
