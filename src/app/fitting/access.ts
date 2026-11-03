// Anonymous signed-link resolution for a fitting share — the fitting
// counterpart of resolveSignedShare in src/app/asset/access.ts. The subject
// of a fitting share is the exact (registration_id, fitting_id) pair (no
// recursion — a fit has no children), so verification is: valid signature,
// and the URL's fit IS the share's subject. Service role, because the
// anonymous caller has no RLS visibility; the page then reads the fit
// explicitly scoped to that pair.
import { parseShareParam, tokenSalt, verifyShareToken } from '@/shareToken'
import { createServiceClient } from '@/utils/supabase/service'

import { isPublicShare } from '../asset/publicShare'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const verifySignedFittingShare = async (
  param: string,
  registrationId: string,
  fittingId: string
): Promise<boolean> => {
  const { shareId, signature } = parseShareParam(param)
  if (signature === '') return false
  // Legacy `<shareId>.<signature>` links name the row; it still has to be the
  // one covering this fit, so the id only narrows the lookup below.
  if (shareId !== null && !UUID_RE.test(shareId)) return false

  let salt: string
  try {
    salt = tokenSalt()
  } catch {
    return false
  }

  // (registration_id, fitting_id) is unique, so the URL's own path identifies
  // the share row without the token having to carry its id.
  const supabase = createServiceClient()
  const query = supabase
    .from('character_fitting_share')
    .select('id, secret')
    .eq('registration_id', registrationId)
    .eq('fitting_id', fittingId)
  const { data: share } = await (shareId === null ? query : query.eq('id', shareId)).maybeSingle<{
    id: string
    secret: string | null
  }>()
  if (!share?.secret) return false
  return verifyShareToken(share.id, share.secret, salt, signature)
}

// Whether the fit is shared with everyone: its share row names nobody
// (docs/sharing-layer/01-asset-share-table.md, state (d)). A public share has
// no signature to carry, so the fit's own URL is its link and a signed-out
// visitor is let in on this alone.
export const isPublicFittingShare = async (registrationId: string, fittingId: string): Promise<boolean> => {
  const { data: share } = await createServiceClient()
    .from('character_fitting_share')
    .select('corporation_ids, alliance_ids, secret')
    .eq('registration_id', registrationId)
    .eq('fitting_id', fittingId)
    .maybeSingle<{ corporation_ids: number[] | null; alliance_ids: number[] | null; secret: string | null }>()
  return share != null && isPublicShare(share)
}

// Whether a signed-out visitor may open the fit: through the signed link they
// carry, or with none through a public share.
export const fittingShareOpens = async (
  share: string | undefined,
  registrationId: string,
  fittingId: string
): Promise<boolean> =>
  share ? verifySignedFittingShare(share, registrationId, fittingId) : isPublicFittingShare(registrationId, fittingId)
