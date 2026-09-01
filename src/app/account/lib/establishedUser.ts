import { cache } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'

import { createClient } from '@/utils/supabase/server'

import { isEstablishedAccount, sessionUserFromClaims, type SessionUser } from './accountStatus'

// The signed-in *member*, or null for an account still mid-flow on the
// anonymous session a character add or sign-up minted
// (docs/open-registration.md). Drop-in for `auth.getUser()` at every gate that
// read "a user exists" as "a member is here" — which, since anonymous users,
// is no longer the same statement.
//
// ── Why getClaims() and not getUser() ─────────────────────────────────────
// `getUser()` sends a request to the Auth server for every call, and the Auth
// server is single-region — so it was a network round trip on the critical path
// of every page, on top of the identical one the middleware already paid
// (src/proxy.ts). Two hops before any page query started.
//
// This project signs its JWTs with an asymmetric key (ES256; the project's
// /auth/v1/.well-known/jwks.json serves the public halves), so the token can be
// verified locally against the JWKS instead — cached per process, and by
// Supabase's edge for 10 minutes. That is exactly what `getClaims()` does, and
// what `src/app/api/mcp/auth.ts` already does for MCP bearers. It is *not*
// `getSession()`: the signature is still verified, so a forged cookie is still
// rejected. It only stops asking the Auth server to confirm liveness.
//
// The tradeoff that buys: a session revoked elsewhere (sign-out on another
// device, a ban, a deleted user) stays valid here until the access token
// expires rather than on the next request. Access tokens are short-lived, so
// the window is bounded — and it is the same tradeoff the MCP surface already
// accepts.
//
// Cached per request: the gate, the header, and any nested layout asking the
// same question share one verification.
export const establishedUser = cache(async (client?: SupabaseClient): Promise<SessionUser | null> => {
  const supabase = client ?? (await createClient())
  const { data } = await supabase.auth.getClaims()
  const user = sessionUserFromClaims(data?.claims)
  if (!user) return null
  if (!user.isAnonymous) return user

  // RLS scopes this to the caller's own registrations, so it is a cheap "do I
  // own a character?" probe rather than a table scan. Only anonymous accounts
  // reach it.
  const { count } = await supabase.from('registration').select('id', { count: 'exact', head: true })
  return isEstablishedAccount({ isAnonymous: true, hasRegistration: (count ?? 0) > 0 }) ? user : null
})
