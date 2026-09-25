import { cache } from 'react'

import { getSdeTypes } from '@/sdeTypes'
import { sdeSupabase } from '@/utils/supabase/sde'

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

// The market the card prices against. Jita is the one every player reads a
// number in; the capture job (market-prices) keeps it hourly.
const PRICE_MARKET = 'jita'

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

// Best Jita ask for each type, from our own hourly capture. Never an
// appraisal-service call: chat clients fetch the card when a link is posted,
// and that must not wait in the appraisal queue or spend its budget.
const sellPrices = async (typeIds: number[]): Promise<Map<number, number | null>> => {
  const { data, error } = await sdeSupabase()
    .from('market_price')
    .select('type_id, sell_min')
    .eq('market', PRICE_MARKET)
    .in('type_id', typeIds)
  if (error) console.error(`[shipCard] prices failed: ${error.message}`)
  return new Map(
    ((data ?? []) as Array<{ type_id: number; sell_min: number | string | null }>).map((row) => [
      Number(row.type_id),
      row.sell_min == null ? null : Number(row.sell_min),
    ])
  )
}

// The card for a ship a share link opens, or null when the link opens
// nothing. Only reached with share parameters: the card must never show a
// ship that its link does not. Cached per request, because the page's
// metadata and viewport both ask for it.
export const loadShipCard = cache(async (itemId: string, share?: string, token?: string): Promise<ShipCard | null> => {
  const ship = await sharedShip(itemId, share, token)
  if (!ship) return null

  const hullTypeId = Number(ship.self.type_id)
  const children: CardChild[] = ship.children.map((child) => ({
    typeId: Number(child.type_id),
    flag: child.location_flag,
    quantity: Number(child.quantity ?? 1) || 1,
    isBlueprintCopy: child.is_blueprint_copy === true,
  }))
  const typeIds = [...new Set([hullTypeId, ...children.map((child) => child.typeId)])]
  const [types, prices] = await Promise.all([getSdeTypes(typeIds), sellPrices(typeIds)])

  const typeName = ship.selfType?.name ?? `#${hullTypeId}`
  const groupName = ship.selfType?.groupName ?? null
  const rows = cardRows(children, types)
  const value = cardValue(hullTypeId, children, types, prices)
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
})
