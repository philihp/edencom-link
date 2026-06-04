import { NextRequest, NextResponse } from 'next/server'

import { fetchTypeNames } from '@/app/typeNames'
import { createServiceClient } from '@/utils/supabase/service'

// Public JSON endpoint for Google Sheets =ImportJSON(): the player's total asset
// inventory, summed by item type, as of an optional timestamp. Authenticated by
// the per-user api_token in the query string (Sheets carries no session cookie),
// so it always recomputes — no caching.
export const dynamic = 'force-dynamic'

const PAGE = 1000

type Row = { typeId: number; typeName: string; quantity: number }

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

  // Sum quantity per type across every version that was live at `at`: a row is
  // valid when it had started by then and either was still open at then or is the
  // current version (its state extends forward past its last_seen_at to now).
  // A later version of an item always starts after the prior version's
  // last_seen_at, so at most one version of any item matches — no double counting.
  // Page in 1000-row chunks: a character can hold tens of thousands of rows and
  // PostgREST caps a select at 1000 (same constraint src/assets.js pages around).
  const totals = new Map<number, number>()
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('asset_over_time')
      .select('type_id, quantity')
      .in('character_id', characterIds)
      .lte('first_seen_at', atIso)
      .or(`last_seen_at.gte.${atIso},is_current.is.true`)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) {
      return NextResponse.json({ error: 'Query failed' }, { status: 500 })
    }
    if (!data || data.length === 0) break
    for (const a of data) {
      const typeId = Number(a.type_id)
      // Singleton items (ships, containers) store a null quantity = one item.
      totals.set(typeId, (totals.get(typeId) ?? 0) + (a.quantity == null ? 1 : Number(a.quantity)))
    }
    if (data.length < PAGE) break
  }

  const names = await fetchTypeNames(totals.keys())
  const rows: Row[] = [...totals.entries()]
    .map(([typeId, quantity]) => ({ typeId, typeName: names[typeId] ?? String(typeId), quantity }))
    .sort((a, b) => b.quantity - a.quantity)

  return NextResponse.json(rows)
}
