import { NextRequest, NextResponse } from 'next/server'

import { resolvePlayer } from '@/utils/apiToken'
import { AT_PARAM_ERROR, parseAtParam } from '@/utils/atParam'
import { omitColumns, parseColumnsParam, selectColumns } from '@/utils/columnsParam'
import { toCsv } from '@/utils/csv'

// Default column set/order, matching character_industry_jobs()'s
// json_build_object in schema.sql. ?columns= can reorder/subset these.
const ALLOWED_COLUMNS = [
  'activity_id',
  'blueprint_id',
  'blueprint_location_id',
  'blueprint_type_id',
  'completed_character_id',
  'completed_date',
  'cost',
  'duration',
  'end_date',
  'facility_id',
  'installer_id',
  'job_id',
  'licensed_runs',
  'output_count',
  'output_location_id',
  'pause_date',
  'probability',
  'product_type_id',
  'runs',
  'start_date',
  'station_id',
  'status',
  'successful_runs',
  'character_name',
] as const

// Columns present in character_industry_jobs()'s json_build_object that are
// selectable via ?columns= but excluded from the default (no ?columns=)
// response, so adding them doesn't retroactively widen existing IMPORTDATA
// formulas that rely on today's default column set.
const DEFAULT_OMIT = ['output_count'] as const

// Public CSV endpoint for Google Sheets =IMPORTDATA(): the player's industry jobs
// across all of their characters, with the owning character's name, as of an
// optional `at` timestamp. The first row is the column headers. Authenticated by
// the per-user api_token in the query string (Sheets carries no session cookie),
// so it always recomputes — no caching.
export const dynamic = 'force-dynamic'
// Headroom over Vercel's default function timeout.
export const maxDuration = 60

export const GET = async (request: NextRequest): Promise<NextResponse> => {
  const { searchParams } = new URL(request.url)

  // `at` time-travels the SCD-2 history (character_industry_job_over_time) to the
  // job versions valid at that moment; default now is the live set.
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

  // Hide terminal-status rows (delivered/cancelled/archived) by default; the
  // sheet typically only cares about in-flight work. Callers that want the full
  // history can opt in with ?include_delivered=true.
  const includeDelivered = /^(1|true|yes)$/i.test(searchParams.get('include_delivered')?.trim() ?? '')

  // Built and returned as one json array by Postgres (character_industry_jobs),
  // which keeps the field order for the sheet's columns and sidesteps PostgREST's
  // max-rows cap.
  const { data: rows, error: rowsError } = await player.supabase.rpc('character_industry_jobs', {
    character_ids: player.characterIds,
    include_delivered: includeDelivered,
    as_of: at.iso,
  })
  if (rowsError) {
    return NextResponse.json({ error: 'Query failed' }, { status: 500 })
  }

  const csvRows =
    columnsResult.columns === null
      ? omitColumns(rows ?? [], DEFAULT_OMIT)
      : selectColumns(rows ?? [], columnsResult.columns)

  return new NextResponse(toCsv(csvRows), {
    headers: { 'Content-Type': 'text/csv; charset=utf-8' },
  })
}
