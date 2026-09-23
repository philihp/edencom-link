import { NextRequest, NextResponse } from 'next/server'

import { RequestTiming, withRequestTiming } from '@/app/api/requestTiming'
import { adjustedPriceCsv, AdjustedPriceRow } from '@/app/sheets/adjusted-prices/adjustedPrices'
import { sdeSupabase } from '@/utils/supabase/sde'

// CCP's adjusted prices (ESI /markets/prices/) as CSV, for =IMPORTDATA. The
// market-adjusted-prices job already captures that feed daily into
// market_adjusted_price, so a sheet reads it here instead of calling ESI from an
// Apps Script. Apps Script fetches from Google's shared IP pool, where every
// other script's ESI traffic counts against the same limit, so those calls fail
// with 420 for reasons the sheet cannot control.
//
// The whole table, ~15k rows, ordered by TypeID: a sheet imports it once onto
// its own tab and looks types up with VLOOKUP. One import serves every lookup
// in the sheet, where the Apps Script fetched the whole feed again for each
// distinct range it was called with.
//
// Public, like the other /sheets/* routes: CCP publishes this to everyone, and
// it holds nothing about the caller.
//
// The job runs once a day, so an hour of CDN cache costs nothing a reader
// would notice, and serving stale while revalidating keeps the paged read
// below off the request path.
const CACHE_CONTROL = 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400'

// PostgREST caps a response at 1000 rows.
const PAGE_SIZE = 1000

const readAll = async (from = 0, acc: AdjustedPriceRow[] = []): Promise<AdjustedPriceRow[]> => {
  const { data, error } = await sdeSupabase()
    .from('market_adjusted_price')
    .select('type_id, adjusted_price, average_price, recorded_at')
    .order('type_id')
    .range(from, from + PAGE_SIZE - 1)
  if (error) throw new Error(`market-adjusted-prices: ${error.message}`)
  acc.push(...(data as AdjustedPriceRow[]))
  return data.length < PAGE_SIZE ? acc : readAll(from + PAGE_SIZE, acc)
}

const handler = async (_request: NextRequest, _context: unknown, timing: RequestTiming): Promise<NextResponse> => {
  const rows = await readAll().catch((error: Error) => error)
  // Surfaced verbatim, like the other public /sheets/* routes: nothing here is
  // private, and the message is how you find out the job has not run yet.
  if (rows instanceof Error) return NextResponse.json({ error: rows.message }, { status: 500 })

  timing.rows = rows.length
  return new NextResponse(adjustedPriceCsv(rows), {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': CACHE_CONTROL },
  })
}

export const GET = withRequestTiming(
  { route: '/sheets/adjusted-prices', surface: 'public_csv', field: 'market_adjusted_price' },
  handler
)
