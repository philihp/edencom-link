import type { SdeType } from '@/sdeTypes'
import { sdeSupabase } from '@/utils/supabase/sde'

import type { AppraisalLine } from './assetLines'
import type { PricedLine } from './pricedLines'

// Appraisal lines priced from our own hourly market capture (market_price),
// one query and no provider request. The link-preview cards use it: the ship
// card as its last resort when no appraisal has come in, the container card
// always, since a chat client fetching a preview must not spend the provider's
// deployment-wide budget. The table is world-readable, so the anon SDE client
// reads it.
export const capturedLines = async (
  lines: AppraisalLine[],
  types: Record<number, SdeType>,
  market: string
): Promise<PricedLine[]> => {
  const idByName = new Map(Object.values(types).map((type) => [type.name, type.typeID]))
  const ids = lines.flatMap((line) => {
    const id = idByName.get(line.name)
    return id == null ? [] : [id]
  })
  const { data, error } = await sdeSupabase()
    .from('market_price')
    .select('type_id, sell_min, buy_max')
    .eq('market', market)
    .in('type_id', ids)
  if (error) console.error(`[capturedLines] prices failed: ${error.message}`)
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
