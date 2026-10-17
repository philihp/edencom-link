// The ladder a page walks to decide whether a visitor may see a subject whose
// authorization is a Revision 3 share row rather than RLS: fully public, a
// signed ?share= link, then the audience arrays. Shared by the pages that read
// their subject through the service role and so have to decide this
// themselves — /bpos and /corpses.
//
// `visible` is the caller's own cookie-session read of the same share table,
// so membership is Postgres's share_audience_matches rather than a second
// implementation up here.
import type { User } from '@supabase/supabase-js'

import { parseShareParam, tokenSalt, verifyShareToken } from '@/shareToken'

export type ShareRow = {
  id: string
  corporation_ids: number[] | null
  alliance_ids: number[] | null
  secret: string | null
}

// How the viewer got in, for a subject whose own people are already ruled out.
export type ShareAccess = 'public' | 'link' | 'audience'

export const linkMatches = (share: ShareRow, param: string | undefined): boolean => {
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

export const shareAccess = async (
  share: ShareRow | null,
  viewer: User | null,
  shareParam: string | undefined,
  visible: () => Promise<boolean>
): Promise<ShareAccess | null> => {
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
