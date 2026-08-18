// Lazy ISK appraisal for the asset viewer (docs/appraisals/03): a selection of
// rows, or a whole container/ship/hangar, priced via innomin.at. Client-
// triggered, so a route handler rather than a server action — it wants JSON,
// status codes and no form semantics.
//
// Every query runs on the cookie-session client, NEVER the service role: the
// *_asset_subtree_items() functions collectAssetLinesForTargets() calls are SECURITY
// INVOKER and rely on RLS to scope their walk, so a service-role caller would
// happily walk (and price) another user's items. This is the same caveat the
// *_location_contents() calls in /asset/[locationId]/page.tsx document, and it's
// why the anonymous share-token path gets no appraise button at all.
import { NextResponse } from 'next/server'
import { all, test, uniq } from 'ramda'

import { appraise, appraisalUrl, MARKETS, type Market } from '@/innominate'
import { timed, withServerTiming } from '@/serverTiming'
import { createClient } from '@/utils/supabase/server'

import { MAX_LINES } from './assetLines'
import { collectAssetLinesForTargets } from './collectAssetLines'

// appraise() blocks polling the shared row for up to 50s while the throttled
// queue drains (POLL_BUDGET_MS in src/innominate.ts, which is sized against a
// 60s function limit). Declare that limit rather than inheriting the platform
// default, which every other long-running route here does too: without it, a
// lowered default would silently truncate queued appraisals mid-poll.
export const maxDuration = 60

const fail = (status: number, error: string, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ ok: false, error, ...extra }, { status })

// Wrapped for Server-Timing (src/serverTiming.ts): this route has two very
// different slow halves — the RLS-scoped subtree walk and the throttled
// innomin.at call — and the panel that fires it is the one place a user
// actually waits, so the split is worth surfacing.
const handler = async (request: Request) => {
  const supabase = await createClient()
  const { data: auth, error: authError } = await supabase.auth.getUser()
  if (authError || !auth?.user) return fail(401, 'Sign in to appraise items.')

  const body = (await request.json().catch(() => null)) as {
    target?: unknown
    targets?: unknown
    market?: unknown
    save?: unknown
  } | null
  // One target (a location, a ship, a container) or many (the asset table's
  // checkbox selection). Both shapes land in the same list — a selection of one
  // is not a different kind of request.
  const requested = Array.isArray(body?.targets) ? body.targets : [body?.target]
  const targets = uniq(requested.filter((t): t is string => typeof t === 'string').map((t) => t.trim()))
  // Ids are bigints kept as strings end to end; anything else can't be one.
  if (targets.length === 0 || !all(test(/^\d+$/), targets)) return fail(400, 'A numeric target id is required.')
  // The walk itself doesn't care how many parents it seeds from, but a URL-sized
  // list of ids arriving from a browser does deserve a ceiling. MAX_LINES is the
  // one the answer is bounded by anyway — a selection past it can't be priced.
  if (targets.length > MAX_LINES) {
    return fail(422, `Too many items selected to appraise at once (${targets.length}, limit ${MAX_LINES}).`)
  }
  // Validated rather than passed through, so the UI can grow a market picker
  // later without this route changing.
  const market: Market = MARKETS.includes(body?.market as Market) ? (body?.market as Market) : 'jita'
  // Opt-in, and only ever set by the viewer's explicit "open this appraisal"
  // arrow. A saved appraisal is stored on the provider's side and gets an id we
  // can link to; everything else here stays side-effect free over there.
  const save = body?.save === true

  // Everything under the target, priced by name — the walk, the blueprint skip
  // and the name merge all live in ./assetLines so this route and the MCP
  // appraise_assets tool can't disagree about what's in a container.
  const { lines, skippedBlueprints, unnamed } = await timed('appraise.walk', () =>
    collectAssetLinesForTargets(supabase, targets)
  )

  if (lines.length === 0) {
    return fail(422, 'Nothing here can be appraised.', {
      ...(skippedBlueprints > 0 && { skipped_blueprints: skippedBlueprints }),
    })
  }
  if (lines.length > MAX_LINES) {
    return fail(422, `Too many distinct item types here to appraise at once (${lines.length}, limit ${MAX_LINES}).`)
  }

  const result = await appraise(lines, market, save)
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
  // appraise_assets tool is the itemized view of this same walk.
  return NextResponse.json({
    ok: true,
    market: appraisal.market,
    total_sell_value: appraisal.totalSellValue,
    total_buy_value: appraisal.totalBuyValue,
    price_split: appraisal.priceSplit,
    total_volume_m3: appraisal.totalVol,
    line_count: lines.length,
    // Only a saved appraisal has somewhere to link to. Absent otherwise rather
    // than null, so the client can just test for it.
    ...(appraisal.appraisalId && { appraisal_url: appraisalUrl(appraisal.appraisalId) }),
    ...(skippedBlueprints > 0 && { skipped_blueprints: skippedBlueprints }),
    ...(unpriced.length > 0 && { unpriced }),
    ...(appraisal.cached && { cached: true }),
    ...(appraisal.rateLimitRemaining != null && { rate_limit_remaining: appraisal.rateLimitRemaining }),
  })
}

export const POST = withServerTiming(handler)
