import { isEstablishedAccount } from './accountStatus.ts'

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

// Which account an EVE SSO callback should land on (docs/open-registration.md,
// stage 3). EVE SSO is not a Supabase identity — it writes a `registration` row
// — so a character can only ever be attached to whatever session is present,
// and the callback has to decide whether that session is the right one.
//
// `(character_id, owner)` is EVE's own answer to "is this the same character,
// still owned by the same player": CCP rolls `owner` when a character changes
// hands, so a match means the returning player is who they were. When that pair
// is already registered to a *different* account and the caller is a drive-by
// — anonymous, owning nothing, which is what a returning player with no cookies
// looks like — signing them into the account that already holds the character
// is both the log-in path and the recovery path. Minting a second account
// holding the same character would split their data in half.
//
// A caller who is already established keeps today's behaviour: the upsert is
// keyed `(user_id, owner)`, so an alt shared between two real accounts stays
// attached to both, and nobody is signed out of the account they are using.
export type CharacterCallbackPlan = 'attach' | 'sign-in-existing'

export const characterCallbackPlan = ({
  caller,
  existingOwnerUserId,
}: {
  caller: { userId: string; isAnonymous: boolean; hasRegistration: boolean }
  existingOwnerUserId: string | null
}): CharacterCallbackPlan =>
  existingOwnerUserId !== null &&
  existingOwnerUserId !== caller.userId &&
  !isEstablishedAccount({ isAnonymous: caller.isAnonymous, hasRegistration: caller.hasRegistration })
    ? 'sign-in-existing'
    : 'attach'

// Which account a verified GICE identity lands on (docs/open-registration.md,
// stage 4). Same question as the EVE callback's, with a different key: the
// OIDC `sub`, recorded in `gice_account`.
//
// - Already linked to somebody else? That account wins and the caller is signed
//   into it — a GICE identity belongs to exactly one account, and the link is
//   the record of which.
// - Holding a session (the usual case now: an anonymous account minted by some
//   earlier flow, or a member linking GICE from settings)? Link it there. For an
//   account that is still a drive-by, that link is what makes it real, and it
//   converts in place — no second account, no invite, `auth.uid()` unchanged.
// - No session at all? There is nothing to link to yet, so the account is minted
//   outright, as it always was.
export type GiceCompletionPlan = 'sign-in-existing' | 'link-in-place' | 'create'

export const giceCompletionPlan = ({
  caller,
  existingLinkUserId,
}: {
  caller: { userId: string } | null
  existingLinkUserId: string | null
}): GiceCompletionPlan => {
  if (existingLinkUserId !== null && existingLinkUserId !== caller?.userId) return 'sign-in-existing'
  return caller ? 'link-in-place' : 'create'
}
