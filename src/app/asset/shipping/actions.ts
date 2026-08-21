'use server'

// The shipping calculator's one server action: a pasted list of items in, a
// Jita-sell appraisal plus a freight quote in each direction out.
//
// It leaves the deployment twice — innomin.at for the prices (item names and
// quantities only) and kumgo.space for the freight (route, volume,
// collateral) — and reads no database at all. Both third parties are reached
// through their single-module wrappers, the same ones the MCP tools use, so
// the throttle, timeouts and error shapes stay in one place.
//
// **Unauthenticated on purpose**, matching the page. There is no account to
// scope: every input arrives in the request and no row is read, so there is
// nothing an anonymous caller could see that a signed-in one couldn't. What a
// public action does expose is cost — each call is one innomin.at request
// against a budget shared by the whole deployment — but that budget is already
// defended where it has to be, by the global leaky-bucket throttle and shared
// cache in src/innominate.ts rather than by who is asking. A flood queues; it
// cannot outspend the budget.
//
// Never throws: the client renders whatever comes back, and a rejected promise
// inside a Suspense boundary would be an error boundary's problem instead of a
// message the player can read.
import { appraise } from '@/innominate'
import { fetchShippingRoutes, requestShippingQuote } from '@/kumgo'

import { describeTier, maxQuotableVolumeM3, resolveShippingRoute, tierForVolume } from '../../api/mcp/shippingQuery'

import { MAX_LINES, parseManifest } from './manifest'

// The two lanes this page answers for. Endpoint names are matched as
// substrings against KumGo's active route list (resolveShippingRoute), so
// "c-j6" keeps working whether the lane is named C-J6MT or C-J6MT VI.
const DIRECTIONS = [
  { label: 'Jita → C-J6', lane: 'Jita → C-J6MT', origin: 'jita', destination: 'c-j6' },
  { label: 'C-J6 → Jita', lane: 'C-J6MT → Jita', origin: 'c-j6', destination: 'jita' },
] as const

export type QuotedDirection = {
  label: string
  lane: string
} & (
  | {
      ok: true
      // The tier the load actually bills under, and what that tier charges.
      tier: string
      rate: string
      collateralFeePercent: number
      deliverTo: string | null
      freightIsk: number
      rushFeeIsk: number
      totalIsk: number
      rewardIsk: number
      // The load is worth more than this tier will insure.
      collateralCapExceeded: boolean
    }
  | { ok: false; message: string }
)

export type ShippingEstimate =
  | { ok: false; message: string }
  | {
      ok: true
      // What the load is worth and how big it is — the two numbers every quote
      // below is derived from.
      sellIsk: number
      buyIsk: number
      volumeM3: number
      lineCount: number
      cached: boolean
      // The largest load either lane has a standard rate for, or null when a
      // lane will take any size. Volume past it is the over-capacity alert.
      maxVolumeM3: number | null
      // Lines innomin.at could not price, with its own suggestions. The quote
      // is still shown (a typo shouldn't blank the page) but the collateral
      // only covers what priced, which the page says out loud.
      unpriced: Array<{ name: string; suggestions: string[] }>
      // Lines it priced as a DIFFERENT item than the one asked for. It matches
      // names fuzzily and reports no error when it settles on something else,
      // so a near miss silently re-prices the cargo. Surfaced rather than
      // trusted.
      substitutions: Array<{ input: string; priced: string }>
      ignored: string[]
      directions: QuotedDirection[]
    }

export const quoteShipping = async (raw: string): Promise<ShippingEstimate> => {
  const { lines, ignored } = parseManifest(raw)
  if (lines.length === 0) return { ok: false, message: 'Paste a list of items to price.' }
  if (lines.length > MAX_LINES) {
    return {
      ok: false,
      message: `That's ${lines.length} distinct items — more than one appraisal can carry (limit ${MAX_LINES}). Split the list.`,
    }
  }

  // Jita sell: what replacing the cargo actually costs at the market it all
  // comes from, which is what the collateral has to cover. save: false — a
  // shipping estimate must leave no appraisal record on innomin.at's side.
  const appraisal = await appraise(lines, 'jita', false)
  if (!appraisal.ok) {
    if (appraisal.kind === 'unconfigured') return { ok: false, message: "Appraisals aren't configured here." }
    if (appraisal.kind === 'rate_limited') {
      const retry = appraisal.retryAfterSeconds != null ? ` Try again in ${appraisal.retryAfterSeconds}s.` : ''
      return { ok: false, message: `The appraisal service is busy — the request budget is shared site-wide.${retry}` }
    }
    return { ok: false, message: appraisal.message }
  }

  const priced = appraisal.appraisal
  const volumeM3 = priced.totalVol
  // The collateral is the Jita sell total, rounded up to a whole ISK: a
  // courier contract can't carry fractions, and rounding down would insure the
  // load for fractionally less than it's worth.
  const collateralIsk = Math.ceil(priced.totalSellValue)

  const routes = await fetchShippingRoutes()
  const classes = routes.ok ? routes.settings.tiers : []

  // Which lane is which, resolved once: the same match drives both the quote
  // and the capacity ceiling the page alerts on.
  const matched = routes.ok
    ? DIRECTIONS.map((direction) => ({
        direction,
        match: resolveShippingRoute(routes.routes, {
          origin: direction.origin,
          destination: direction.destination,
          classes,
        }),
      }))
    : []

  // The biggest load any resolved lane still has a standard rate for. Null
  // means at least one lane is unbounded, so there is nothing to warn about.
  // flatMap rather than filter+map so the match stays narrowed to its ok case.
  const caps = matched.flatMap(({ match }) => (match.ok ? [maxQuotableVolumeM3(match.route, classes)] : []))
  const maxVolumeM3 = caps.length === 0 || caps.some((c) => c == null) ? null : Math.max(...caps.map((c) => c ?? 0))

  const directions: QuotedDirection[] =
    volumeM3 <= 0
      ? DIRECTIONS.map(({ label, lane }) => ({
          label,
          lane,
          ok: false as const,
          message: 'Nothing here has a volume to ship.',
        }))
      : !routes.ok
        ? DIRECTIONS.map(({ label, lane }) => ({ label, lane, ok: false as const, message: routes.message }))
        : await Promise.all(
            matched.map(async ({ direction: { label, lane }, match }): Promise<QuotedDirection> => {
              if (!match.ok) return { label, lane, ok: false, message: match.message }
              const tier = tierForVolume(match.route, classes, volumeM3)
              // rush: false — the rush fee is a large flat charge nobody asked
              // for, and this page quotes the ordinary service.
              const quote = await requestShippingQuote(match.route.id, volumeM3, collateralIsk, false)
              if (!quote.ok) return { label, lane, ok: false, message: quote.message }
              return {
                label,
                lane,
                ok: true,
                // The tier is named from the shared classes, since the route's
                // own tier entry carries only its id.
                tier: classes.find((c) => c.id === tier?.tierId)?.name ?? '—',
                rate: tier ? describeTier(tier) : 'no standard rate',
                collateralFeePercent: match.route.collateralFeePercent,
                deliverTo: quote.route.destinationFullName,
                freightIsk: quote.quote.freightIsk,
                rushFeeIsk: quote.quote.rushFeeIsk,
                totalIsk: quote.quote.totalIsk,
                rewardIsk: quote.quote.rewardIsk,
                collateralCapExceeded: quote.quote.collateralCapExceeded,
              }
            })
          )

  return {
    ok: true,
    sellIsk: collateralIsk,
    buyIsk: priced.totalBuyValue,
    volumeM3,
    lineCount: lines.length,
    cached: priced.cached,
    maxVolumeM3,
    unpriced: priced.items
      .filter((item) => item.error != null)
      .map((item) => ({ name: item.name, suggestions: item.possibleMatches })),
    // The response carries one entry per requested line, in request order, and
    // its `name` is what the service RESOLVED to — so zipping by index against
    // what was sent is what catches "construction blocks" coming back priced
    // as something else.
    substitutions: lines.flatMap((line, index) => {
      const item = priced.items[index]
      if (item == null || item.error != null) return []
      return item.name.toLowerCase() === line.name.toLowerCase() ? [] : [{ input: line.name, priced: item.name }]
    }),
    ignored,
    directions,
  }
}
