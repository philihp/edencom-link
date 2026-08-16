import { NextRequest, NextResponse } from 'next/server'

import { CHARACTER_ORDER_COLUMNS } from '@/app/api/csvColumns'
import { RequestTiming, withRequestTiming } from '@/app/api/requestTiming'
import { resolvePlayer } from '@/utils/apiToken'
import { AT_PARAM_ERROR, parseAtParam } from '@/utils/atParam'
import { parseColumnsParam, selectColumns } from '@/utils/columnsParam'
import { toCsv } from '@/utils/csv'

// Default column set/order (src/app/api/csvColumns.ts, shared with the link
// drop-in templates). ?columns= can reorder/subset these.
const ALLOWED_COLUMNS = CHARACTER_ORDER_COLUMNS

// Public CSV endpoint for Google Sheets =IMPORTDATA(): the player's open market
// orders across all of their characters, with the owning character's name, as of
// an optional `at` timestamp. The first row is the column headers. Authenticated
// by the per-user api_token in the query string (Sheets carries no session
// cookie), so it always recomputes — no caching.
export const dynamic = 'force-dynamic'
// Headroom over Vercel's default function timeout.
export const maxDuration = 60

const handler = async (request: NextRequest, _context: unknown, timing: RequestTiming): Promise<NextResponse> => {
  const { searchParams } = new URL(request.url)

  // `at` reconstructs which orders were open at that moment from the SCD-2
  // history (character_order_over_time); default now is the live open set.
  if (searchParams.get('at') !== null) timing.served = 'historical'
  const at = parseAtParam(searchParams.get('at'))
  if (!at.ok) {
    return NextResponse.json({ error: AT_PARAM_ERROR }, { status: 400 })
  }

  const columnsResult = parseColumnsParam(searchParams.get('columns'), ALLOWED_COLUMNS)
  if (!columnsResult.ok) {
    return NextResponse.json({ error: columnsResult.error }, { status: 400 })
  }

  const player = await resolvePlayer(searchParams.get('token')?.trim())
  if (!player.ok) {
    return NextResponse.json({ error: player.error }, { status: player.status })
  }

  // Built and returned as one json array by Postgres (character_orders), which keeps
  // the field order for the sheet's columns and sidesteps PostgREST's max-rows cap.
  const { data: rows, error: rowsError } = await player.supabase.rpc('character_orders', {
    registration_ids: player.registrationIds,
    as_of: at.iso,
  })
  if (rowsError) {
    return NextResponse.json({ error: 'Query failed' }, { status: 500 })
  }

  timing.rows = (rows ?? []).length
  return new NextResponse(toCsv(selectColumns(rows ?? [], columnsResult.columns)), {
    headers: { 'Content-Type': 'text/csv; charset=utf-8' },
  })
}

export const GET = withRequestTiming(
  { route: '/api/character/orders', surface: 'legacy_csv', field: 'character_orders', deprecated: true },
  handler
)
