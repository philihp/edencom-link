import { NextRequest, NextResponse } from 'next/server'

import { resolvePlayer } from '@/utils/apiToken'
import { AT_PARAM_ERROR, parseAtParam } from '@/utils/atParam'
import { toCsv } from '@/utils/csv'

// Public CSV endpoint for Google Sheets =IMPORTDATA(): the player's raw asset
// rows (one per item stack) with the owning character's name, as of an optional
// timestamp. The first row is the column headers. Authenticated by the per-user
// api_token in the query string (Sheets carries no session cookie), so it always
// recomputes — no caching.
export const dynamic = 'force-dynamic'
// Headroom over Vercel's default function timeout for a large inventory.
export const maxDuration = 60

export const GET = async (request: NextRequest): Promise<NextResponse> => {
  const { searchParams } = new URL(request.url)

  // `at` is the moment to reconstruct the inventory at; default to now (the live
  // inventory). character_asset_over_time keeps full SCD-2 history, so any past
  // time works.
  const at = parseAtParam(searchParams.get('at'))
  if (!at.ok) {
    return NextResponse.json({ error: AT_PARAM_ERROR }, { status: 400 })
  }
  const atIso = at.iso

  const player = await resolvePlayer(searchParams.get('token')?.trim())
  if (!player.ok) {
    return NextResponse.json({ error: player.error }, { status: player.status })
  }

  // The raw rows live at `at`, with character_name, built and returned as one json
  // array by Postgres (character_asset_snapshot_at) — keeping the rollup/paging out
  // of this function is what kept the endpoint under Vercel's timeout, and a single
  // json scalar sidesteps PostgREST's max-rows cap.
  const { data: rows, error: rowsError } = await player.supabase.rpc('character_asset_snapshot_at', {
    character_ids: player.characterIds,
    as_of: atIso,
  })
  if (rowsError) {
    return NextResponse.json({ error: 'Query failed' }, { status: 500 })
  }

  return new NextResponse(toCsv(rows ?? []), {
    headers: { 'Content-Type': 'text/csv; charset=utf-8' },
  })
}
