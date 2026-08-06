// Viewer authorization for /lens/[id] and its CSV route. Two doors, same as
// every Revision 3 share subject:
//
// - RLS: the caller's cookie client reads the lens row directly — the owner
//   policy or the audience policy (corporation/alliance membership, or a
//   fully-public shared lens) decides. Works signed-out too: the anon role
//   reaches only shared-and-public rows.
// - Signed link: ?share=<lensId>.<signature> verified against the row's
//   secret + TOKEN_SALT via the service client (an anonymous HTTP request is
//   invisible to RLS — link-only lenses match no one there by design).
//
// Either way the run is gated on the CREATOR still holding the lens flag —
// un-flagging an account turns its shared lenses off, the dark-launch lever.
import { LENS_FLAG, hasFlag } from '@/flags'
import { tokenSalt, verifyShareToken } from '@/shareToken'
import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import type { LensRecord } from './run'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ResolvedLens = { lens: LensRecord; viewerIsOwner: boolean }

const resolveSignedLens = async (lensId: string, param: string): Promise<LensRecord | null> => {
  const dot = param.indexOf('.')
  if (dot <= 0) return null
  const shareId = param.slice(0, dot)
  const signature = param.slice(dot + 1)
  if (shareId !== lensId || signature === '') return null

  let salt: string
  try {
    salt = tokenSalt()
  } catch {
    return null
  }

  const service = createServiceClient()
  const { data: lens } = await service.from('lens').select('*').eq('id', lensId).maybeSingle<LensRecord>()
  if (!lens || !lens.enabled || !lens.secret) return null
  return verifyShareToken(lens.id, lens.secret, salt, signature) ? lens : null
}

export const resolveLens = async (lensId: string, shareParam?: string): Promise<ResolvedLens | null> => {
  if (!UUID_RE.test(lensId)) return null

  const supabase = await createClient()
  const { data: auth } = await supabase.auth.getUser()
  const viewerId = auth?.user?.id ?? null

  // RLS is the authority for the membership/public/owner doors.
  const { data: rlsLens } = await supabase.from('lens').select('*').eq('id', lensId).maybeSingle<LensRecord>()

  const lens = rlsLens ?? (shareParam ? await resolveSignedLens(lensId, shareParam) : null)
  if (!lens) return null
  if (!(await hasFlag(lens.user_id, LENS_FLAG))) return null

  return { lens, viewerIsOwner: viewerId !== null && viewerId === lens.user_id }
}
