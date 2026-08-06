// Anonymous signed-link resolution for a fitting share — the fitting
// counterpart of resolveSignedShare in src/app/asset/access.ts. The subject
// of a fitting share is the exact (registration_id, fitting_id) pair (no
// recursion — a fit has no children), so verification is: valid signature,
// and the URL's fit IS the share's subject. Service role, because the
// anonymous caller has no RLS visibility; the page then reads the fit
// explicitly scoped to that pair.
import { parseShareParam, tokenSalt, verifyShareToken } from '@/shareToken'
import { createServiceClient } from '@/utils/supabase/service'

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
