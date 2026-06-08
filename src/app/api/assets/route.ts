import { NextRequest, NextResponse } from 'next/server'

import { resolvePlayer } from '@/utils/apiToken'
import { toCsv } from '@/utils/csv'

// Public CSV endpoint for Google Sheets =IMPORTDATA(): the player's raw asset
// rows (one per item stack) with the owning character's name, as of an optional
// timestamp. The first row is the column headers. Authenticated by the per-user
// api_token in the query string (Sheets carries no session cookie), so it always
// recomputes — no caching.
export const dynamic = 'force-dynamic'
// Headroom over Vercel's default function timeout for a large inventory.
export const maxDuration = 60

// Pad a partial ISO date/time out to a full UTC timestamp so callers can pass
// just the precision they care about: 2026 → 2026-01-01T00:00:00Z, 2026-05 →
// 2026-05-01T00:00:00Z, 2026-05-30T18 → 2026-05-30T18:00:00Z, etc. Inputs that
// already carry fractional seconds or a timezone (e.g. a full toISOString) don't
// match the bare-prefix pattern and are returned untouched for Date to parse.
const completePartialAt = (value: string): string => {
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?(?:[T ](\d{2}))?(?::(\d{2}))?(?::(\d{2}))?$/.exec(value)
  if (!m) return value
  const [, year, month = '01', day = '01', hour = '00', minute = '00', second = '00'] = m
  return `${year}-${month}-${day}T${hour}:${minute}:${second}Z`
}

export const GET = async (request: NextRequest): Promise<NextResponse> => {
  const { searchParams } = new URL(request.url)

  // `at` is the moment to reconstruct the inventory at; default to now (the live
  // inventory). asset_over_time keeps full SCD-2 history, so any past time works.
  const atParam = searchParams.get('at')
  const at = atParam ? new Date(completePartialAt(atParam.trim())) : new Date()
  if (Number.isNaN(at.getTime())) {
    return NextResponse.json(
      { error: 'Invalid `at` timestamp; use ISO 8601 (e.g. 2026-06-01T00:00:00Z)' },
      { status: 400 }
    )
  }
  const atIso = at.toISOString()

  const player = await resolvePlayer(searchParams.get('token')?.trim())
  if (!player.ok) {
    return NextResponse.json({ error: player.error }, { status: player.status })
  }

  // The raw rows live at `at`, with character_name, built and returned as one json
  // array by Postgres (asset_snapshot_at) — keeping the rollup/paging out of this
  // function is what kept the endpoint under Vercel's timeout, and a single json
  // scalar sidesteps PostgREST's max-rows cap.
  const { data: rows, error: rowsError } = await player.supabase.rpc('asset_snapshot_at', {
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
