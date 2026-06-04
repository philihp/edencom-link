import { NextRequest, NextResponse } from 'next/server'

import { createServiceClient } from '@/utils/supabase/service'

// Public JSON endpoint for Google Sheets =ImportJSON(): the player's raw asset
// rows (one per item stack) with the owning character's name, as of an optional
// timestamp. Authenticated by the per-user api_token in the query string (Sheets
// carries no session cookie), so it always recomputes — no caching.
export const dynamic = 'force-dynamic'
// Headroom over Vercel's default function timeout for a large inventory.
export const maxDuration = 60

export const GET = async (request: NextRequest): Promise<NextResponse> => {
  const { searchParams } = new URL(request.url)

  const token = searchParams.get('token')?.trim()
  if (!token) {
    return NextResponse.json({ error: 'Missing api token' }, { status: 401 })
  }

  // `at` is the moment to reconstruct the inventory at; default to now (the live
  // inventory). asset_over_time keeps full SCD-2 history, so any past time works.
  const atParam = searchParams.get('at')
  const at = atParam ? new Date(atParam) : new Date()
  if (Number.isNaN(at.getTime())) {
    return NextResponse.json(
      { error: 'Invalid `at` timestamp; use ISO 8601 (e.g. 2026-06-01T00:00:00Z)' },
      { status: 400 }
    )
  }
  const atIso = at.toISOString()

  const supabase = createServiceClient()

  // Resolve the token to its owner. Service role bypasses RLS, so we scope every
  // subsequent query to this user_id ourselves.
  const { data: settings, error: settingsError } = await supabase
    .from('user_settings')
    .select('user_id')
    .eq('api_token', token)
    .maybeSingle()
  if (settingsError) {
    return NextResponse.json({ error: 'Lookup failed' }, { status: 500 })
  }
  if (!settings) {
    return NextResponse.json({ error: 'Invalid api token' }, { status: 401 })
  }

  // The player's characters.
  const { data: characters, error: charactersError } = await supabase
    .from('registration')
    .select('id')
    .eq('user_id', settings.user_id)
  if (charactersError) {
    return NextResponse.json({ error: 'Lookup failed' }, { status: 500 })
  }
  const characterIds = (characters ?? []).map((c) => c.id)
  if (characterIds.length === 0) {
    return NextResponse.json([])
  }

  // The raw rows live at `at`, with character_name, built and returned as one
  // jsonb array by Postgres (asset_snapshot_at) — keeping the rollup/paging out of
  // this function is what kept the endpoint under Vercel's timeout, and a single
  // jsonb scalar sidesteps PostgREST's max-rows cap.
  const { data: rows, error: rowsError } = await supabase.rpc('asset_snapshot_at', {
    character_ids: characterIds,
    as_of: atIso,
  })
  if (rowsError) {
    return NextResponse.json({ error: 'Query failed' }, { status: 500 })
  }

  return NextResponse.json(rows ?? [])
}
