// Execute a Lens: the stored query, in-process against the /api/graphql
// executable schema, under the CREATOR's context (docs/sharing-layer/07-lens.md).
// No HTTP hop and no flag check here — callers authorize the viewer (see
// access.ts) before running. Mode 'token' on the creator context means the
// session-only surfaces reject exactly as they do for Bearer callers, and the
// resolvers' leak-guard .in('registration_id', …) is the barrier.
import { graphql } from 'graphql'

import { contextForUser } from '@/app/api/graphql/context'
import { schema } from '@/app/api/graphql/schema'
import { recordRequest } from '@/observability'
import { lensRows } from './flatten'
import { topLevelFieldOf } from './validate'

export type LensRecord = {
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

export type LensResult = { data: unknown; errors: string[] }

// Which serving surface a run should report itself as, for the request.timing
// metric (src/observability.js). Omitted for runs that aren't a request being
// served — the editor's preview, the create/update preflights.
export type LensRunSurface = { surface: 'lens_csv' | 'lens_view'; route: string }

export type LensRunOptions = {
  timing?: LensRunSurface
  // The CSV surface's cap raise (GraphqlContext.caps): a Sheets tab can't page,
  // so exports run under EXPORT_CAP and the route refuses when even that bit.
  exporting?: boolean
}

export const runLens = async (
  lens: Pick<LensRecord, 'user_id' | 'query' | 'variables'>,
  { timing, exporting = false }: LensRunOptions = {}
): Promise<LensResult> => {
  const startedAt = Date.now()
  const contextValue = await contextForUser(lens.user_id, { exporting })
  const result = await graphql({
    schema,
    source: lens.query,
    variableValues: lens.variables ?? {},
    contextValue,
  })
  const out = { data: result.data ?? null, errors: (result.errors ?? []).map((e) => e.message) }
  // The duration covers building the creator context plus executing the query —
  // everything between "the lens is authorized" and "rows exist in memory",
  // which is the DB-bound span the BRIN measurement wants. Lenses read only
  // current data, so `served` is always 'live' here; the historical side of the
  // comparison comes from the legacy at= routes.
  if (timing) {
    recordRequest({
      route: timing.route,
      surface: timing.surface,
      field: topLevelFieldOf(lens.query),
      served: 'live',
      outcome: out.errors.length > 0 && out.data == null ? 'query_failed' : 'ok',
      rows: lensRows(out.data).length,
      durationMs: Date.now() - startedAt,
    })
  }
  return out
}
