// Anonymous signed-link resolution for a fitting share — the fitting
// counterpart of resolveSignedShare in src/app/asset/access.ts. The subject
// of a fitting share is the exact (registration_id, fitting_id) pair (no
// recursion — a fit has no children), so verification is: valid signature,
// and the URL's fit IS the share's subject. Service role, because the
// anonymous caller has no RLS visibility; the page then reads the fit
// explicitly scoped to that pair.
import { tokenSalt, verifyShareToken } from '@/shareToken'
import { createServiceClient } from '@/utils/supabase/service'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const verifySignedFittingShare = async (
  param: string,
  registrationId: string,
  fittingId: string
): Promise<boolean> => {
  const dot = param.indexOf('.')
  if (dot <= 0) return false
  const shareId = param.slice(0, dot)
  const signature = param.slice(dot + 1)
  if (!UUID_RE.test(shareId) || signature === '') return false

  let salt: string
  try {
    salt = tokenSalt()
  } catch {
    return false
  }

  const supabase = createServiceClient()
  const { data: share } = await supabase
    .from('character_fitting_share')
    .select('id, registration_id, fitting_id, secret')
    .eq('id', shareId)
    .maybeSingle<{ id: string; registration_id: string; fitting_id: number | string; secret: string | null }>()
  if (!share?.secret) return false
  if (share.registration_id !== registrationId || String(share.fitting_id) !== fittingId) return false
  return verifyShareToken(share.id, share.secret, salt, signature)
}
