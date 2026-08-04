import type { SupabaseClient } from '@supabase/supabase-js'
import { GraphQLError } from 'graphql'

import { GRAPHQL_FLAG, hasFlag } from '@/flags'
import { resolvePlayer } from '@/utils/apiToken'
import { createClient } from '@/utils/supabase/server'

// The per-request context every resolver receives. Two auth modes share it:
//
// - token: `Authorization: Bearer <api_token>` (the same per-user token the
//   Sheets CSV endpoints use) resolves via the SERVICE-ROLE client, which
//   bypasses RLS — so registrationIds is the only barrier between users.
// - session: the Supabase auth cookie (the in-browser /graphql page), where
//   RLS scopes every read anyway.
//
// THE LEAK GUARD: every resolver must filter .in('registration_id', ...) from
// ctx.registrationIds explicitly, in BOTH modes. In session mode that's
// redundant with RLS (harmless); in token mode it is load-bearing.
export type GraphqlContext = {
  supabase: SupabaseClient
  mode: 'session' | 'token'
  userId: string
  registrationIds: string[]
  // registration uuid → character name, for owner filters and ownerName fields.
  ownerNameById: Map<string, string>
}

const deny = (message: string, status: number): never => {
  throw new GraphQLError(message, { extensions: { http: { status } } })
}

export const buildContext = async (request: Request): Promise<GraphqlContext> => {
  const authorization = request.headers.get('authorization') ?? ''
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : ''

  let supabase: SupabaseClient
  let mode: GraphqlContext['mode']
  let userId: string

  if (bearer !== '') {
    const player = await resolvePlayer(bearer)
    if (!player.ok) return deny(player.error, player.status)
    supabase = player.supabase
    userId = player.userId
    mode = 'token'
  } else {
    supabase = await createClient()
    const { data, error } = await supabase.auth.getUser()
    if (error || !data?.user) return deny('Not signed in. Send Authorization: Bearer <api_token>, or sign in.', 401)
    userId = data.user.id
    mode = 'session'
  }

  if (!(await hasFlag(userId, GRAPHQL_FLAG))) {
    deny('The GraphQL API is not enabled for this account.', 403)
  }

  // Owner names come from the user's own registration rows — scoped by user_id
  // here rather than through fetchOwners, whose unscoped registration select
  // would return every user's characters under the service client.
  const { data: registrations, error: registrationError } = await supabase
    .from('registration')
    .select('id, name')
    .eq('user_id', userId)
  if (registrationError) deny('Lookup failed', 500)

  const rows = (registrations ?? []) as Array<{ id: string; name: string }>
  return {
    supabase,
    mode,
    userId,
    registrationIds: rows.map((r) => r.id),
    ownerNameById: new Map(rows.map((r) => [r.id, r.name])),
  }
}
