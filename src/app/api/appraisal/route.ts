// Lazy ISK appraisal for the asset viewer (docs/appraisals/03): one row, or a
// whole container/ship/hangar, priced via innomin.at. Client-triggered, so a
// route handler rather than a server action — it wants JSON, status codes and
// no form semantics.
//
// Every query runs on the cookie-session client, NEVER the service role: the
// *_asset_subtree_items() functions are SECURITY INVOKER and rely on RLS to
// scope their walk, so a service-role caller would happily walk (and price)
// another user's items. This is the same caveat the *_location_contents() calls
// in /asset/[locationId]/page.tsx document, and it's why the anonymous
// share-token path gets no appraise button at all.
import { forEach } from 'ramda'
import { NextResponse } from 'next/server'

import { appraise, MARKETS, type AppraisalItemInput, type Market } from '@/innominate'
import { getSdeTypes } from '@/sdeTypes'
import { createClient } from '@/utils/supabase/server'
import { BLUEPRINT_CATEGORY_ID } from '../mcp/lib'

// One appraisal is always exactly one upstream request — the 200/hour budget is
// deployment-wide, so looping per item is never an option. A hangar with more
// distinct types than a single batch can carry is therefore refused outright
// rather than truncated: a partial total still looks authoritative, and being
// quietly wrong about how much someone's stuff is worth is worse than saying no.
const MAX_LINES = 500

type SubtreeRow = { type_id: number | string; quantity: number | string }
type SelfRow = { type_id: number | string; quantity: number | string | null; is_singleton: boolean | null }

const fail = (status: number, error: string, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ ok: false, error, ...extra }, { status })

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: auth, error: authError } = await supabase.auth.getUser()
  if (authError || !auth?.user) return fail(401, 'Sign in to appraise items.')

  const body = (await request.json().catch(() => null)) as { target?: unknown; market?: unknown } | null
  const target = typeof body?.target === 'string' ? body.target.trim() : ''
  // Ids are bigints kept as strings end to end; anything else can't be one.
  if (!/^\d+$/.test(target)) return fail(400, 'A numeric target id is required.')
  // Validated rather than passed through, so the UI can grow a market picker
  // later without this route changing.
  const market: Market = MARKETS.includes(body?.market as Market) ? (body?.market as Market) : 'jita'

  // The target is either one of the caller's own items (ship, container or plain
  // stack) or a bare place id — a station, structure or solar system. RLS
  // decides what's visible, so an id the caller doesn't own simply reads as a
  // location whose subtree comes back empty.
  const { data: characterSelf } = await supabase
    .from('character_asset')
    .select('type_id, quantity, is_singleton')
    .eq('item_id', target)
    .maybeSingle<SelfRow>()
  const { data: corpSelf } = characterSelf
    ? { data: null }
    : await supabase
        .from('corp_asset')
        .select('type_id, quantity, is_singleton')
        .eq('item_id', target)
        .maybeSingle<SelfRow>()
  const self = characterSelf ?? corpSelf

  // Everything nested under the target, from both hangars. An item lives in
  // exactly one of the two tables, so unioning the two can't double-count.
  const [{ data: characterRows }, { data: corpRows }] = await Promise.all([
    supabase.rpc('character_asset_subtree_items', { parent: target }),
    supabase.rpc('corp_asset_subtree_items', { parent: target }),
  ])

  const quantities = new Map<number, number>()
  const add = (typeId: number, quantity: number) => quantities.set(typeId, (quantities.get(typeId) ?? 0) + quantity)
  forEach(
    (r: SubtreeRow) => add(Number(r.type_id), Number(r.quantity)),
    [...((characterRows ?? []) as SubtreeRow[]), ...((corpRows ?? []) as SubtreeRow[])]
  )
  // Those functions return strictly the contents, so an item target still owes
  // its own line — the hull of a ship, the container itself. A bare location has
  // nothing to add.
  if (self) add(Number(self.type_id), self.is_singleton ? 1 : Number(self.quantity ?? 1))

  const typeIds = [...quantities.keys()]
  const sdeTypes = await getSdeTypes(typeIds)

  // Asset rows carry no way to tell a worthless copy from an original, so
  // pricing blueprints would be wrong more often than right. Skipped, and said
  // out loud rather than silently folded into the total.
  const priceable = typeIds.filter((id) => sdeTypes[id]?.categoryID !== BLUEPRINT_CATEGORY_ID)
  const skippedBlueprints = typeIds.length - priceable.length

  // The API is keyed on item name, so a type the SDE can't name can't be priced
  // at all. Reported by id rather than dropped on the floor.
  const unnamed = priceable.filter((id) => !sdeTypes[id]?.name).map((id) => `#${id}`)

  // Distinct type ids sharing one name are rare but real in the SDE; merging
  // here keeps them from being sent as two lines and counted twice.
  const lines = new Map<string, AppraisalItemInput>()
  forEach((id: number) => {
    const name = sdeTypes[id]?.name
    if (!name) return
    const existing = lines.get(name)
    lines.set(name, { name, quantity: (existing?.quantity ?? 0) + (quantities.get(id) ?? 1) })
  }, priceable)

  if (lines.size === 0) {
    return fail(422, 'Nothing here can be appraised.', {
      ...(skippedBlueprints > 0 && { skipped_blueprints: skippedBlueprints }),
    })
  }
  if (lines.size > MAX_LINES) {
    return fail(422, `Too many distinct item types here to appraise at once (${lines.size}, limit ${MAX_LINES}).`)
  }

  const result = await appraise([...lines.values()], market)
  if (!result.ok) {
    if (result.kind === 'unconfigured') return fail(503, "Appraisals aren't configured on this deployment.")
    if (result.kind === 'rate_limited') {
      return fail(429, result.message, { retry_after_seconds: result.retryAfterSeconds })
    }
    return fail(502, result.message)
  }

  const { appraisal } = result
  const unpriced = [...unnamed, ...appraisal.items.filter((i) => i.error != null).map((i) => i.name)]

  // Per-line prices are deliberately not returned: the UI shows totals only, and
  // a 500-type hangar's itemization would be pointless payload. The MCP
  // appraise_items tool is the itemized view.
  return NextResponse.json({
    ok: true,
    market: appraisal.market,
    total_sell_value: appraisal.totalSellValue,
    total_buy_value: appraisal.totalBuyValue,
    price_split: appraisal.priceSplit,
    total_volume_m3: appraisal.totalVol,
    line_count: lines.size,
    ...(skippedBlueprints > 0 && { skipped_blueprints: skippedBlueprints }),
    ...(unpriced.length > 0 && { unpriced }),
    ...(appraisal.cached && { cached: true }),
    ...(appraisal.rateLimitRemaining != null && { rate_limit_remaining: appraisal.rateLimitRemaining }),
  })
}
