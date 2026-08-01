import { NextRequest, NextResponse } from 'next/server'

import { resolvePlayer } from '@/utils/apiToken'
import { AT_PARAM_ERROR, parseAtParam } from '@/utils/atParam'
import { parseColumnsParam, selectColumns } from '@/utils/columnsParam'
import { toCsv } from '@/utils/csv'

// Default column set/order, matching character_orders()'s json_build_object
// in schema.sql. ?columns= can reorder/subset these.
const ALLOWED_COLUMNS = [
  'duration',
  'escrow',
  'is_buy_order',
  'is_corporation',
  'issued',
  'location_id',
  'min_volume',
  'order_id',
  'price',
  'range',
  'region_id',
  'type_id',
  'volume_remain',
  'volume_total',
  'character_name',
] as const

// Public CSV endpoint for Google Sheets =IMPORTDATA(): the player's open market
// orders across all of their characters, with the owning character's name, as of
// an optional `at` timestamp. The first row is the column headers. Authenticated
// by the per-user api_token in the query string (Sheets carries no session
// cookie), so it always recomputes — no caching.
export const dynamic = 'force-dynamic'
// Headroom over Vercel's default function timeout.
export const maxDuration = 60

export const GET = async (request: NextRequest): Promise<NextResponse> => {
  const { searchParams } = new URL(request.url)

  // `at` reconstructs which orders were open at that moment from the SCD-2
  // history (character_order_over_time); default now is the live open set.
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

  return new NextResponse(toCsv(selectColumns(rows ?? [], columnsResult.columns)), {
    headers: { 'Content-Type': 'text/csv; charset=utf-8' },
  })
}
