// "Is this a real account?" — our question, not Supabase's.
//
// An account can now exist before its owner has an identity: starting an EVE
// SSO character add mints a Supabase anonymous user first
// (src/app/account/lib/anonymousSession.ts), because the callback can only
// attach a character to a session that already exists. So a user existing no
// longer means a member is signed in. Worse, the flag cannot simply be
// inverted: an account whose only identity is an EVE SSO character stays
// `is_anonymous = true` forever, because EVE SSO is not a Supabase identity —
// it writes a `registration` row instead.
//
// So an account is *established* when it has stopped being a drive-by: either
// Supabase considers it permanent (email/password, Discord, or the GICE
// placeholder address — all of which clear `is_anonymous`), or it owns at least
// one EVE character. Nothing else can be true of an account that only got as
// far as starting a flow and walking away.
//
// The pure predicate lives alone in this module so `node --test` can import it
// without dragging in the server client; the caller that fetches its inputs is
// establishedUser.ts next door. The SQL twin is is_established_account().
export const isEstablishedAccount = ({
  isAnonymous,
  hasRegistration,
}: {
  isAnonymous: boolean
  hasRegistration: boolean
}): boolean => !isAnonymous || hasRegistration

// What a gate needs to know about the caller, and nothing more.
//
// Deliberately *not* Supabase's `User`. Every field here comes out of the
// access token's own claims, which is what lets establishedUser() verify
// locally instead of asking the Auth server; `User` carries fields the token
// does not (`created_at`, `last_sign_in_at`, identities), and returning it
// would invite a call site to read one that is silently undefined. Narrowing
// the type makes that a build error instead — a page that genuinely needs the
// profile record fetches it explicitly, as /account/settings does.
export type SessionUser = {
  id: string
  email?: string
  isAnonymous: boolean
}

// Map a verified access token's claims onto that shape, or null when the token
// carries no subject (no session).
//
// auth-js types both `is_anonymous` and `email` as optional, and both really
// can be absent: an EVE-SSO-only account had no address of its own until the
// placeholder landed (docs/open-registration.md). So `is_anonymous` is read as
// a tri-state defaulting to *not* anonymous, and a non-string email is dropped
// rather than coerced.
//
// Note which way that default leans: absent means the caller is treated as
// permanent and admitted without the registration probe. That is the more
// permissive branch, and it is deliberate — Supabase stamps `is_anonymous` on
// every token an anonymous sign-in mints, so its absence means the session came
// from a flow that is permanent by definition (email/password, Discord, the
// GICE placeholder). It also matches exactly what the previous `!user.is_anonymous`
// check did on the `User` object, so this refactor changes no gate's answer.
export const sessionUserFromClaims = (claims: Record<string, unknown> | null | undefined): SessionUser | null => {
  const sub = claims?.sub
  if (typeof sub !== 'string' || sub === '') return null
  return {
    id: sub,
    email: typeof claims?.email === 'string' ? claims.email : undefined,
    isAnonymous: claims?.is_anonymous === true,
  }
}
