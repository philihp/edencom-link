import { createServiceClient } from '@/utils/supabase/service'

import type { PricedLine } from './pricedLines'

// The ship_appraisal cache: the last appraisal of one ship, as per-line unit
// prices (see the table comment in schema.sql). Service role only — the table
// has no policy — so both callers must have proved the caller may see the ship
// before they get here: the Appraise route by its RLS walk, the ship card by a
// verified share link.

export type ShipAppraisal = { market: string; lines: PricedLine[]; appraisedAt: string }

export const readShipAppraisal = async (itemId: string): Promise<ShipAppraisal | null> => {
  const { data, error } = await createServiceClient()
    .from('ship_appraisal')
    .select('market, lines, appraised_at')
    .eq('item_id', itemId)
    .maybeSingle<{ market: string; lines: PricedLine[]; appraised_at: string }>()
  if (error) console.error(`[shipAppraisal] read failed: ${error.message}`)
  return data ? { market: data.market, lines: data.lines, appraisedAt: data.appraised_at } : null
}

// Best-effort: a cache that cannot be written only means the next card asks
// the provider again.
export const writeShipAppraisal = async (itemId: string, market: string, lines: PricedLine[]): Promise<void> => {
  const { error } = await createServiceClient()
    .from('ship_appraisal')
    .upsert({ item_id: itemId, market, lines, appraised_at: new Date().toISOString() }, { onConflict: 'item_id' })
  if (error) console.error(`[shipAppraisal] write failed: ${error.message}`)
}
