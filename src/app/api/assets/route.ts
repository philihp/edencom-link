import { NextRequest, NextResponse } from 'next/server'

import { createServiceClient } from '@/utils/supabase/service'

// Public JSON endpoint for Google Sheets =ImportJSON(): the player's total asset
// inventory, summed by item type, as of an optional timestamp. Authenticated by
// the per-user api_token in the query string (Sheets carries no session cookie),
// so it always recomputes — no caching. Returns raw type ids; the sheet resolves
// names itself, which keeps the response fast (no external lookups per type).
export const dynamic = 'force-dynamic'
// Headroom over Vercel's default function timeout for a large inventory.
export const maxDuration = 60

type Row = { typeId: number; quantity: number }

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

  // Sum quantity per type across every version that was live at `at`. The rollup
  // runs in Postgres (asset_inventory_at) rather than paging every raw row into
  // this function — a full inventory is tens of thousands of rows, and shipping
  // them here timed the request out. Returns one row per type id.
  const { data: totals, error: totalsError } = await supabase.rpc('asset_inventory_at', {
    character_ids: characterIds,
    as_of: atIso,
  })
  if (totalsError) {
    return NextResponse.json({ error: 'Query failed' }, { status: 500 })
  }
  const inventory = (totals ?? []) as { type_id: number; quantity: number }[]

  const rows: Row[] = inventory
    .map(({ type_id, quantity }) => ({ typeId: Number(type_id), quantity: Number(quantity) }))
    .sort((a, b) => b.quantity - a.quantity)

  return NextResponse.json(rows)
}
