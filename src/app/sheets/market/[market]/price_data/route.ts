import { NextRequest, NextResponse } from 'next/server'

import { RequestTiming, withRequestTiming } from '@/app/api/requestTiming'
import { parseTypeIds, PriceRow, priceDataXml } from '@/app/sheets/market/priceData'
import { TRACKED_MARKETS } from '@/gnfMarket.js'
import { AT_PARAM_ERROR, parseAtParam } from '@/utils/atParam'
import { sdeSupabase } from '@/utils/supabase/sde'

// Our captured prices for one block of types, as the XML a sheet reads with
// =IMPORTXML — the same chunked shape as goonmetrics' price_data API, so a sheet
// can price a long list one block of rows at a time instead of importing a
// whole market:
//
//   =IMPORTXML("https://edencom.link/sheets/market/C-J6MT/price_data?type_id="
//              &JOIN(",",$A$2:$A$101), "//price_data/type")
//
// The shape and how it differs from goonmetrics are in ../../priceData.ts.
// Public, uncredentialed and cached like the /sheets/market/<market> CSV, for
// the same reasons (see that route). Extra query params are ignored, so a
// sheet's cache-busting seed (…&"&"&RefreshSeed) passes through harmlessly.
const LIVE_CACHE = 'public, max-age=300, s-maxage=900, stale-while-revalidate=3600'
const HISTORICAL_CACHE = 'public, max-age=86400, s-maxage=604800, immutable'

const COLUMNS = 'type_id, buy_max, sell_min, strategy, valid_from, valid_until'

const MARKETS = new Set<string>(TRACKED_MARKETS)

// Live reads the market_price view, answered by the (market, type_id) partial
// unique index. A past moment needs the time-travel predicate over the whole
// history — the same one market_price_snapshot() uses for its historical branch.
const readPrices = (market: string, typeIds: number[], asOf: string | null) => {
  const ids = [...new Set(typeIds)]
  return asOf === null
    ? sdeSupabase().from('market_price').select(COLUMNS).eq('market', market).in('type_id', ids)
    : sdeSupabase()
        .from('market_price_over_time')
        .select(COLUMNS)
        .eq('market', market)
        .in('type_id', ids)
        .lte('valid_from', asOf)
        .or(`is_current.eq.true,valid_until.gte."${asOf}"`)
}

const handler = async (
  request: NextRequest,
  { params }: { params: Promise<{ market: string }> },
  timing: RequestTiming
): Promise<NextResponse> => {
  const market = decodeURIComponent((await params).market)
  if (!MARKETS.has(market)) {
    return NextResponse.json(
      { error: `Unknown market; tracked markets are ${TRACKED_MARKETS.join(', ')}` },
      { status: 404 }
    )
  }

  const { searchParams } = new URL(request.url)
  const typeIds = parseTypeIds(searchParams.get('type_id'))
  if (!typeIds.ok) return NextResponse.json({ error: typeIds.error }, { status: 400 })

  // Absent stays null (live), never now(): see the CSV route for why.
  const rawAt = searchParams.get('at')?.trim()
  const at = rawAt ? parseAtParam(rawAt) : null
  if (at !== null && !at.ok) return NextResponse.json({ error: AT_PARAM_ERROR }, { status: 400 })

  const { data: rows, error } = await readPrices(market, typeIds.typeIds, at === null ? null : at.iso)
  if (error) return NextResponse.json({ error: `market-prices: ${error.message}` }, { status: 500 })

  const historical = at !== null && at.ok && at.iso < new Date().toISOString()

  timing.rows = typeIds.typeIds.length
  if (historical) timing.served = 'historical'
  return new NextResponse(priceDataXml(market, typeIds.typeIds, (rows ?? []) as PriceRow[]), {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': historical ? HISTORICAL_CACHE : LIVE_CACHE,
    },
  })
}

export const GET = withRequestTiming(
  { route: '/sheets/market/[market]/price_data', surface: 'public_csv', field: 'market_price' },
  handler
)
