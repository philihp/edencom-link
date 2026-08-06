// Execute a Lens: the stored query, in-process against the /api/graphql
// executable schema, under the CREATOR's context (docs/sharing-layer/07-lens.md).
// No HTTP hop and no flag check here — callers authorize the viewer (see
// access.ts) before running. Mode 'token' on the creator context means the
// session-only surfaces reject exactly as they do for Bearer callers, and the
// resolvers' leak-guard .in('registration_id', …) is the barrier.
import { graphql } from 'graphql'

import { contextForUser } from '@/app/api/graphql/context'
import { schema } from '@/app/api/graphql/schema'

export type LensRecord = {
  id: string
  user_id: string
  name: string
  query: string
  variables: Record<string, unknown>
  shared: boolean
  corporation_ids: number[] | null
  alliance_ids: number[] | null
  secret: string | null
  updated_at: string
}

export type LensResult = { data: unknown; errors: string[] }

export const runLens = async (lens: Pick<LensRecord, 'user_id' | 'query' | 'variables'>): Promise<LensResult> => {
  const contextValue = await contextForUser(lens.user_id)
  const result = await graphql({
    schema,
    source: lens.query,
    variableValues: lens.variables ?? {},
    contextValue,
  })
  return { data: result.data ?? null, errors: (result.errors ?? []).map((e) => e.message) }
}
