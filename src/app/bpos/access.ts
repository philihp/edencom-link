// Who the /bpos/[name] URL names, and who is allowed to look.
//
// The URL addresses one of two subjects: a CORPORATION (its blueprints live in
// corp_blueprint, where anything deposited into a corp hangar ends up) or an
// ACCOUNT (every character's originals in one list). Both read through the
// service-role client like the /corpses share page does — which means every
// query here is explicitly scoped to the subject, and the authorization is this
// module's job rather than RLS's.
import type { SupabaseClient, User } from '@supabase/supabase-js'
import { groupBy } from 'ramda'

import { parseShareParam, tokenSalt, verifyShareToken } from '@/shareToken'
import { createServiceClient } from '@/utils/supabase/service'

import { characterSlug, pickCorporation, pickMain, slugLikePattern, type CorporationCandidate } from './slug'

export type BposRegistration = {
  id: string
  user_id: string
  name: string
  is_main: boolean | null
  created_at: string | null
}

export type BposAccount = {
  userId: string
  // Every character on the account: the scope of the blueprint read. Only the
  // main is ever named on the page — the collection is pooled, but which alts
  // it came from isn't anyone else's business.
  registrations: BposRegistration[]
  mainName: string
}

export type BposCorporation = {
  corporationId: number
  name: string
}

// What the URL resolved to. Discriminated so the page and the share plumbing
// branch exhaustively rather than on the presence of a field.
export type BposSubject = ({ kind: 'account' } & BposAccount) | ({ kind: 'corporation' } & BposCorporation)

const REGISTRATION_COLUMNS = 'id, user_id, name, is_main, created_at'

// Slug → the account whose MAIN character carries that name.
//
// Two hops, because the URL names one character and the page needs the whole
// account: a wildcard probe finds every character whose name could slugify to
// this (dashes stand in for any single character), then each candidate
// ACCOUNT's own main is recomputed and compared exactly. A character that
// merely matches the slug but isn't its account's main doesn't open the page —
// the URL means "this person", and a person is their main.
//
// `viewer` breaks the tie in the rare case where the same character name is
// registered on two accounts: the viewer's own account wins, and otherwise an
// ambiguous slug resolves to nothing rather than to a coin flip.
export const resolveBposAccount = async (slug: string, viewer: User | null): Promise<BposAccount | null> => {
  if (slug === '') return null
  const service = createServiceClient()

  const { data: probe } = await service
    .from('registration')
    .select(REGISTRATION_COLUMNS)
    .ilike('name', slugLikePattern(slug))
    .returns<BposRegistration[]>()

  const userIds = [...new Set((probe ?? []).filter((r) => characterSlug(r.name) === slug).map((r) => r.user_id))]
  if (userIds.length === 0) return null

  const { data: rows } = await service
    .from('registration')
    .select(REGISTRATION_COLUMNS)
    .in('user_id', userIds)
    .returns<BposRegistration[]>()

  const accounts: BposAccount[] = Object.entries(groupBy((r: BposRegistration) => r.user_id, rows ?? [])).flatMap(
    ([userId, registrations = []]) => {
      const main = pickMain(registrations)
      if (!main || characterSlug(main.name) !== slug) return []
      return [{ userId, registrations, mainName: main.name }]
    }
  )

  return accounts.find((a) => a.userId === viewer?.id) ?? (accounts.length === 1 ? accounts[0] : null)
}

// Slug → the corporation carrying that name, over the world-readable
// corporation directory. One hop: unlike an account, the subject IS the row the
// probe found.
export const resolveBposCorporation = async (slug: string): Promise<BposCorporation | null> => {
  if (slug === '') return null

  const { data } = await createServiceClient()
    .from('corporation')
    .select('corporation_id, name')
    .ilike('name', slugLikePattern(slug))
    .returns<CorporationCandidate[]>()

  return pickCorporation(data ?? [], slug)
}

// Corporation first, then account. There are far fewer corporations than
// registrations, so the corp probe is the cheap one and settles the common
// case; the account resolver's two hops only run when no corporation answers.
// A name collision therefore hides the character's page behind the corp's,
// which EVE makes near-impossible by refusing a corporation an in-use character
// name.
export const resolveBposSubject = async (slug: string, viewer: User | null): Promise<BposSubject | null> => {
  const corporation = await resolveBposCorporation(slug)
  if (corporation) return { kind: 'corporation', ...corporation }

  const account = await resolveBposAccount(slug, viewer)
  return account ? { kind: 'account', ...account } : null
}

// How a viewer got in, or null if they didn't. The subject's own people always
// see their page (that's where the share dialog lives), so 'owner' (the
// account's holder) and 'member' (anyone with a character in the corporation)
// are checked before any share row is read.
export type BposAccess = 'owner' | 'member' | 'public' | 'link' | 'audience'

// Whether the viewer may manage the share — the two "this is my page" kinds.
export const canManageShare = (access: BposAccess): boolean => access === 'owner' || access === 'member'

type ShareRow = {
  id: string
  corporation_ids: number[] | null
  alliance_ids: number[] | null
  secret: string | null
}

const linkMatches = (share: ShareRow, param: string | undefined): boolean => {
  if (param === undefined || param === '' || share.secret == null) return false
  const { signature } = parseShareParam(param)
  if (signature === '') return false
  try {
    return verifyShareToken(share.id, share.secret, tokenSalt(), signature)
  } catch {
    // No TOKEN_SALT on this deployment: links simply don't resolve.
    return false
  }
}

// The share ladder both subjects walk once their own people are ruled out:
// no row → 404, fully public, signed link, then the audience arrays. `visible`
// re-asks the same table as the VIEWER, so membership is Postgres's
// share_audience_matches rather than a second implementation here.
const shareAccess = async (
  share: ShareRow | null,
  viewer: User | null,
  shareParam: string | undefined,
  visible: () => Promise<boolean>
): Promise<BposAccess | null> => {
  if (!share) return null

  const corporationIds = share.corporation_ids ?? []
  const allianceIds = share.alliance_ids ?? []

  // Fully public — the Revision 3 row that names no one. Decided here rather
  // than by asking the table as `anon`, whose evaluation of the audience
  // predicate would depend on my_corporation_ids() being reachable to it.
  if (share.secret == null && corporationIds.length === 0 && allianceIds.length === 0) return 'public'

  if (linkMatches(share, shareParam)) return 'link'

  if (viewer && (await visible())) return 'audience'

  return null
}

export const bposAccess = async (
  subject: BposSubject,
  viewer: User | null,
  // The viewer's own cookie-session client: the audience check runs as them, so
  // the membership test is Postgres's (share_audience_matches) rather than a
  // second implementation here.
  viewerClient: SupabaseClient,
  shareParam: string | undefined
): Promise<BposAccess | null> => {
  const service = createServiceClient()

  if (subject.kind === 'account') {
    if (viewer?.id === subject.userId) return 'owner'

    const { data: share } = await service
      .from('bpo_share')
      .select('id, corporation_ids, alliance_ids, secret')
      .eq('user_id', subject.userId)
      .maybeSingle<ShareRow>()

    return shareAccess(share, viewer, shareParam, async () => {
      const { data } = await viewerClient
        .from('bpo_share')
        .select('id')
        .eq('user_id', subject.userId)
        .maybeSingle<{ id: string }>()
      return data != null
    })
  }

  // A member of the corporation always sees its page. Checked against the
  // viewer's own registrations through the service role, because `registration`
  // is RLS-hidden and the cookie client would answer only for rows it can see —
  // which is the same set, but this keeps the check in one shape for both
  // subjects.
  if (viewer) {
    const { data: membership } = await service
      .from('registration')
      .select('id')
      .eq('user_id', viewer.id)
      .eq('corporation_id', subject.corporationId)
      .limit(1)
      .maybeSingle<{ id: string }>()
    if (membership) return 'member'
  }

  const { data: share } = await service
    .from('corp_bpo_share')
    .select('id, corporation_ids, alliance_ids, secret')
    .eq('corporation_id', subject.corporationId)
    .maybeSingle<ShareRow>()

  return shareAccess(share, viewer, shareParam, async () => {
    const { data } = await viewerClient
      .from('corp_bpo_share')
      .select('id')
      .eq('corporation_id', subject.corporationId)
      .maybeSingle<{ id: string }>()
    return data != null
  })
}
