// "Is this a real account?" — our question, not Supabase's.
//
// Every visitor now carries a Supabase session: the root layout signs them in
// anonymously on arrival (src/app/layout/anonymousSession.tsx), so a user
// existing no longer means a member is signed in. Worse, the flag cannot simply
// be inverted: an account whose only identity is an EVE SSO character stays
// `is_anonymous = true` forever, because EVE SSO is not a Supabase identity —
// it writes a `registration` row instead.
//
// So an account is *established* when it has stopped being a drive-by: either
// Supabase considers it permanent (email/password, Discord, or the GICE
// placeholder address — all of which clear `is_anonymous`), or it owns at least
// one EVE character. Nothing else can be true of an account that has merely
// loaded a page.
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
