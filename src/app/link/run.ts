// Execute a Link: the stored query, in-process against the /api/graphql
// executable schema, under the CREATOR's context (docs/sharing-layer/07-link.md).
// No HTTP hop and no flag check here — callers authorize the viewer (see
// access.ts) before running. Mode 'token' on the creator context means the
// session-only surfaces reject exactly as they do for Bearer callers, and the
// resolvers' leak-guard .in('registration_id', …) is the barrier.
import { graphql } from 'graphql'

import { contextForUser } from '@/app/api/graphql/context'
import { schema } from '@/app/api/graphql/schema'
import { recordRequest } from '@/observability'
import { timed } from '@/serverTiming'
import { linkRows } from './flatten'
import { topLevelFieldOf } from './validate'

export type LinkRecord = {
  id: string
  user_id: string
  name: string
  query: string
  variables: Record<string, unknown>
  enabled: boolean
  corporation_ids: number[] | null
  alliance_ids: number[] | null
  secret: string | null
  updated_at: string
}

export type LinkResult = { data: unknown; errors: string[] }

// Which serving surface a run should report itself as, for the request.timing
// metric (src/observability.js). Omitted for runs that aren't a request being
// served — the editor's preview, the create/update preflights.
export type LinkRunSurface = { surface: 'link_csv' | 'link_view'; route: string }

export type LinkRunOptions = {
  timing?: LinkRunSurface
  // The CSV surface's cap raise (GraphqlContext.caps): a Sheets tab can't page,
  // so exports run under EXPORT_CAP and the route refuses when even that bit.
  exporting?: boolean
}

export const runLink = async (
  link: Pick<LinkRecord, 'user_id' | 'query' | 'variables'>,
  { timing, exporting = false }: LinkRunOptions = {}
): Promise<LinkResult> => {
  const startedAt = Date.now()
  // Split into two spans because they fail differently: building the creator
  // context is a handful of fixed lookups, while execution is the resolvers'
  // (unbounded) query work. A slow link is nearly always the second.
  const contextValue = await timed('link.context', () => contextForUser(link.user_id, { exporting }))
  const result = await timed('link.execute', () =>
    graphql({
      schema,
      source: link.query,
      variableValues: link.variables ?? {},
      contextValue,
    })
  )
  const out = { data: result.data ?? null, errors: (result.errors ?? []).map((e) => e.message) }
  // The duration covers building the creator context plus executing the query —
  // everything between "the link is authorized" and "rows exist in memory",
  // which is the DB-bound span the BRIN measurement wants. Links read only
  // current data, so `served` is always 'live' here; the historical side of the
  // comparison comes from the legacy at= routes.
  if (timing) {
    recordRequest({
      route: timing.route,
      surface: timing.surface,
      field: topLevelFieldOf(link.query),
      served: 'live',
      outcome: out.errors.length > 0 && out.data == null ? 'query_failed' : 'ok',
      rows: linkRows(out.data).length,
      durationMs: Date.now() - startedAt,
    })
  }
  return out
}
