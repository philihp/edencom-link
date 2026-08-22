// Who the /bpos/[name] URL names, and who is allowed to look.
//
// The showcase is account-scoped (every character's originals in one list), so
// it reads through the service-role client like the /corpses share page does —
// which means every query here is explicitly scoped to the owning account's
// registrations, and the authorization is this module's job rather than RLS's.
import type { SupabaseClient, User } from '@supabase/supabase-js'
import { groupBy } from 'ramda'

import { parseShareParam, tokenSalt, verifyShareToken } from '@/shareToken'
import { createServiceClient } from '@/utils/supabase/service'

import { characterSlug, pickMain, slugLikePattern } from './slug'

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

// How a viewer got in, or null if they didn't. The owner always sees their own
// page (that's where the share dialog lives), so 'owner' is checked before any
// share row is read.
export type BposAccess = 'owner' | 'public' | 'link' | 'audience'

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

export const bposAccess = async (
  account: BposAccount,
  viewer: User | null,
  // The viewer's own cookie-session client: the audience check runs as them, so
  // the membership test is Postgres's (share_audience_matches) rather than a
  // second implementation here.
  viewerClient: SupabaseClient,
  shareParam: string | undefined
): Promise<BposAccess | null> => {
  if (viewer?.id === account.userId) return 'owner'

  const service = createServiceClient()
  const { data: share } = await service
    .from('bpo_share')
    .select('id, corporation_ids, alliance_ids, secret')
    .eq('user_id', account.userId)
    .maybeSingle<ShareRow>()
  if (!share) return null

  const corporationIds = share.corporation_ids ?? []
  const allianceIds = share.alliance_ids ?? []

  // Fully public — the Revision 3 row that names no one. Decided here rather
  // than by asking the table as `anon`, whose evaluation of the audience
  // predicate would depend on my_corporation_ids() being reachable to it.
  if (share.secret == null && corporationIds.length === 0 && allianceIds.length === 0) return 'public'

  if (linkMatches(share, shareParam)) return 'link'

  if (viewer) {
    const { data: visible } = await viewerClient
      .from('bpo_share')
      .select('id')
      .eq('user_id', account.userId)
      .maybeSingle<{ id: string }>()
    if (visible) return 'audience'
  }

  return null
}
