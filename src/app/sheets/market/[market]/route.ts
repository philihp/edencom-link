import { NextRequest, NextResponse } from 'next/server'

import { TRACKED_MARKETS } from '@/gnfMarket.js'
import { AT_PARAM_ERROR, parseAtParam } from '@/utils/atParam'
import { toCsv } from '@/utils/csv'
import { sdeSupabase } from '@/utils/supabase/sde'

// Serves one market's captured prices as the CSV the industry spreadsheet used
// to build for itself. It previously ran an Apps Script (getMarketPrices) that
// fetched appraise.gnf.lt on every recalculation and reshaped the JSON in the
// sheet; the market-prices job now captures that feed hourly into
// market_price_over_time, so the sheet can =IMPORTDATA() this instead — and,
// because the capture is SCD-2, ask for a past moment with ?at=.
//
// The header row is TypeID,Updated,Buy,Sell — the exact columns and order the
// Apps Script returned, so pointing the tab here is a drop-in swap. Two columns
// are added after those: Since (when this price took effect, i.e. how long it
// has stood unchanged) and Strategy (how the service derived it — 'ccp' means
// no live orders at all, just CCP's adjusted price). Sheets ignores trailing
// columns a formula doesn't reference, so appending rather than inserting keeps
// existing formulas pointed at the same letters.
//
// Public, like /sheets/[file] and for the same reason: the data is a third
// party's view of the public market, contains nothing about the caller's
// account, and is identical for everyone — so no api_token, unlike
// /api/character/*.
//
// Cache design differs from /sheets/[file] though. Those files change only when
// CCP ships an SDE build, so they key an ETag on sde_build and cache for a day.
// This changes hourly, so a live request gets a short cache; a ?at= request
// names a moment that has already happened and whose answer can therefore never
// change, so it's cached hard.
const LIVE_CACHE = 'public, max-age=300, s-maxage=900, stale-while-revalidate=3600'
const HISTORICAL_CACHE = 'public, max-age=86400, s-maxage=604800, immutable'

// Sheets URLs read better ending in .csv, and IMPORTDATA doesn't care either
// way — accept both /sheets/market/jita and /sheets/market/jita.csv.
const stripExtension = (segment: string) => segment.replace(/\.csv$/i, '')

// Emitted alone when a query matches nothing, so the sheet sees an empty table
// rather than an empty response. Must stay in step with the row shape below.
const HEADER = 'TypeID,Updated,Buy,Sell,Since,Strategy'

// A market is only servable if the job is capturing it; anything else would
// answer an empty CSV that looks like "this market has no prices" rather than
// "nothing has ever recorded it".
const MARKETS = new Set<string>(TRACKED_MARKETS)

export const GET = async (
  request: NextRequest,
  { params }: { params: Promise<{ market: string }> }
): Promise<NextResponse> => {
  const market = stripExtension(decodeURIComponent((await params).market))
  if (!MARKETS.has(market)) {
    return NextResponse.json(
      { error: `Unknown market; tracked markets are ${TRACKED_MARKETS.join(', ')}` },
      { status: 404 }
    )
  }

  const { searchParams } = new URL(request.url)
  const rawAt = searchParams.get('at')
  // Same `at` grammar as the Sheets API endpoints: a partial ISO date is padded
  // out, an absent one means now.
  const at = parseAtParam(rawAt)
  if (!at.ok) return NextResponse.json({ error: AT_PARAM_ERROR }, { status: 400 })

  // Built and returned as one json array by Postgres, which fixes the column
  // order and sidesteps PostgREST's max-rows cap — a market carries 20k+ types,
  // so a plain select would silently return the first 1000.
  const { data: rows, error } = await sdeSupabase().rpc('market_price_snapshot', {
    market_id: market,
    as_of: at.iso,
  })
  // Surfaced verbatim, like /sheets/[file] and /esf/[file] rather than the
  // opaque 'Query failed' the per-user endpoints answer with: everything here
  // is public data, and the message is how you find out the mirror hasn't been
  // migrated or populated yet.
  if (error) return NextResponse.json({ error: `market-prices: ${error.message}` }, { status: 500 })

  const csv = toCsv(
    (rows ?? []).map((row: Record<string, unknown>) => ({
      TypeID: row.type_id,
      Updated: row.updated,
      Buy: row.buy_max,
      Sell: row.sell_min,
      Since: row.since,
      Strategy: row.strategy,
    }))
  )

  // toCsv derives its header from the first row, so an empty result is an empty
  // body — which IMPORTDATA reports as an error rather than as an empty table.
  // Emit the header alone instead (an `at` older than the first capture, or a
  // market whose first run hasn't landed).
  const body = csv === '' ? HEADER : csv

  // A moment that has already passed can never gain or lose rows — a later run
  // only ever writes versions with a newer valid_from, and closing a row leaves
  // its valid_until past the asked-for instant — so a historical answer is
  // immutable and cacheable hard. An `at` at or after now is just a spelling of
  // "live" and must not be.
  const historical = at.iso < new Date().toISOString()

  return new NextResponse(body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Cache-Control': rawAt?.trim() && historical ? HISTORICAL_CACHE : LIVE_CACHE,
    },
  })
}
