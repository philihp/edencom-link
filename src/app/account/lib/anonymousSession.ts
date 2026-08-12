import type { SupabaseClient, User } from '@supabase/supabase-js'

// Mint the account a flow is about to need, and not a moment sooner.
//
// Open registration (docs/open-registration.md) wants an account to exist
// *before* the visitor has an identity to hang on it — EVE SSO's callback, for
// one, can only attach a character to a session that already exists. The
// anonymous user is how we get there, but it is created lazily: at the point
// someone starts adding a character or signing up, never on a page view, so
// reading the site mints nothing.
//
// Server-side on purpose. Called from a Server Action, `signInAnonymously()`
// writes the session cookies through the SSR client's cookie adapter, so the
// very next request is already signed in — no client round trip, no refresh
// dance. It will NOT work from a Server Component, where cookie writes are
// dropped (see src/utils/supabase/server.ts).
//
// Returns the existing user untouched when there is one — including an
// anonymous one, which is an account in mid-flow, not a fresh visitor.
export const ensureSession = async (supabase: SupabaseClient): Promise<User | null> => {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (user) return user

  const { data, error } = await supabase.auth.signInAnonymously()
  if (error) {
    // Anonymous sign-ins disabled, or rate limited. The caller decides what to
    // do about it; from here it is indistinguishable from "no account".
    console.warn(`[anonymous-session] ${error.message}`)
    return null
  }
  return data.user
}
