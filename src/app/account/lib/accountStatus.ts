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
