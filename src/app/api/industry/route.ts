import { NextRequest, NextResponse } from 'next/server'

import { resolvePlayer } from '@/utils/apiToken'

// Public JSON endpoint for Google Sheets =ImportJSON(): the player's industry jobs
// across all of their characters, with the owning character's name. Authenticated
// by the per-user api_token in the query string (Sheets carries no session
// cookie), so it always recomputes — no caching.
export const dynamic = 'force-dynamic'
// Headroom over Vercel's default function timeout.
export const maxDuration = 60

export const GET = async (request: NextRequest): Promise<NextResponse> => {
  const { searchParams } = new URL(request.url)

  const player = await resolvePlayer(searchParams.get('token')?.trim())
  if (!player.ok) {
    return NextResponse.json({ error: player.error }, { status: player.status })
  }

  // Built and returned as one json array by Postgres (industry_jobs), which keeps
  // the field order for the sheet's columns and sidesteps PostgREST's max-rows cap.
  const { data: rows, error: rowsError } = await player.supabase.rpc('industry_jobs', {
    character_ids: player.characterIds,
  })
  if (rowsError) {
    return NextResponse.json({ error: 'Query failed' }, { status: 500 })
  }

  return NextResponse.json(rows ?? [])
}
