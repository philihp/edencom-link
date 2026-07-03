import { NextRequest, NextResponse } from 'next/server'

import { resolvePlayer } from '@/utils/apiToken'
import { toCsv } from '@/utils/csv'

// Public CSV endpoint for Google Sheets =IMPORTDATA(): the current live
// blueprint rows (one per blueprint stack) for the corporation(s) the
// caller's characters belong to. The first row is the column headers.
// Authenticated by the per-user api_token in the query string (Sheets carries
// no session cookie), so it always recomputes — no caching.
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export const GET = async (request: NextRequest): Promise<NextResponse> => {
  const { searchParams } = new URL(request.url)

  const player = await resolvePlayer(searchParams.get('token')?.trim())
  if (!player.ok) {
    return NextResponse.json({ error: player.error }, { status: player.status })
  }

  // Built and returned as one json array by Postgres (corp_blueprints), which
  // keeps the field order for the sheet's columns and sidesteps PostgREST's
  // max-rows cap.
  const { data: rows, error: rowsError } = await player.supabase.rpc('corp_blueprints', {
    character_ids: player.characterIds,
  })
  if (rowsError) {
    return NextResponse.json({ error: 'Query failed' }, { status: 500 })
  }

  return new NextResponse(toCsv(rows ?? []), {
    headers: { 'Content-Type': 'text/csv; charset=utf-8' },
  })
}
