// How an email/password sign-up reaches an account, given whatever session the
// visitor arrived with (docs/open-registration.md, stage 2).
//
// Since anonymous bootstrap, someone can already hold an account before they
// have any identity — they started adding a character, or opened a flow that
// minted one. Signing up from there must NOT create a second account: the
// anonymous user is converted in place (`auth.updateUser`), which is Supabase's
// documented anonymous→permanent path and keeps `auth.uid()` stable, so a
// referral or a character already affixed carries over.
//
// The fallback matters as much: with no session at all — the bootstrap never
// ran, cookies blocked — `auth.signUp` still mints the account outright, so
// registration never depends on the anonymous mint having succeeded.
//
// A session that is already permanent is somebody who is signed in; sending it
// down the sign-up path lets Supabase answer for itself rather than silently
// rewriting a live account's credentials.
export type EmailSignupPlan = 'convert' | 'sign-up'

export const emailSignupPlan = (session: { isAnonymous: boolean } | null): EmailSignupPlan =>
  session?.isAnonymous ? 'convert' : 'sign-up'
