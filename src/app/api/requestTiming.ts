import { NextRequest, NextResponse } from 'next/server'

import { recordRequest } from '@/observability'

// Wraps a route handler so every return path emits one `request.timing` metric
// (src/observability.js) — the measurement seam the BRIN index project reads
// (docs/brin-indexes/README.md). The wrapper owns the clock and the
// status→outcome mapping; the handler reports what only it knows (row count,
// live vs historical) through the mutable `timing` it receives, so a route
// stays a one-line change: wrap the handler, set `timing.rows`/`timing.served`
// where they become known.

export type RequestTiming = {
  // Rows in the response; stays null on requests that never produce any.
  rows: number | null
  // 'historical' when the caller asked for a past moment (an explicit at=),
  // exercising the SCD-2 time-travel predicate instead of the live rows.
  served: 'live' | 'historical'
}

export type TimedSurface = 'legacy_csv' | 'lens_csv' | 'lens_view' | 'graphql' | 'public_csv'

type TimingMeta = {
  // The static route template — never an interpolated id, so the metric's
  // cardinality stays flat.
  route: string
  surface: TimedSurface
  // The Postgres function the route calls (CSV routes) or the GraphQL root
  // field (lens/graphql surfaces).
  field: string | null
  // Stamps a `Deprecation: true` response header: the api_token CSV routes are
  // superseded by lenses (docs/sharing-layer/09-sheets-parity.md) but stay
  // live — they are the BRIN measurement instrument and the only at= surface.
  deprecated?: boolean
}

const outcomeOf = (status: number): string => {
  if (status < 400) return 'ok'
  if (status === 400) return 'bad_request'
  if (status === 401) return 'unauthorized'
  if (status === 404) return 'not_found'
  return 'query_failed'
}

export const withRequestTiming =
  <C>(meta: TimingMeta, handler: (request: NextRequest, context: C, timing: RequestTiming) => Promise<NextResponse>) =>
  async (request: NextRequest, context: C): Promise<NextResponse> => {
    const startedAt = Date.now()
    const timing: RequestTiming = { rows: null, served: 'live' }
    try {
      const response = await handler(request, context, timing)
      if (meta.deprecated) response.headers.set('Deprecation', 'true')
      recordRequest({
        route: meta.route,
        surface: meta.surface,
        field: meta.field,
        served: timing.served,
        outcome: outcomeOf(response.status),
        status: response.status,
        rows: timing.rows,
        durationMs: Date.now() - startedAt,
      })
      return response
    } catch (error) {
      recordRequest({
        route: meta.route,
        surface: meta.surface,
        field: meta.field,
        served: timing.served,
        outcome: 'query_failed',
        status: 500,
        rows: null,
        durationMs: Date.now() - startedAt,
      })
      throw error
    }
  }
