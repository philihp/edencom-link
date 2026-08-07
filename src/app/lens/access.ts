// Viewer authorization for /lens/[id] and its CSV route. Two doors, same as
// every Revision 3 share subject:
//
// - RLS: the caller's cookie client reads the lens row directly — the owner
//   policy or the audience policy (corporation/alliance membership, or a
//   fully-public shared lens) decides. Works signed-out too: the anon role
//   reaches only shared-and-public rows.
// - Signed link: ?share=<signature> verified against the row's secret +
//   TOKEN_SALT via the service client (an anonymous HTTP request is invisible
//   to RLS — link-only lenses match no one there by design). The lens the
//   signature must verify against is the one in the path, so the token needn't
//   name it; legacy `<lensId>.<signature>` links still resolve, and the viewer
//   rewrites them to the short form in the address bar.
//
// Either way the run is gated on the CREATOR still holding the lens flag —
// un-flagging an account turns its shared lenses off, the dark-launch lever.
//
// The path id may be truncated (any canonical-format prefix of ≥8 hex digits,
// e.g. /lens/da204490): it expands to the oldest-created matching lens before
// either door is tried — see expandLensId.
import { LENS_FLAG, hasFlag } from '@/flags'
import { parseShareParam, tokenSalt, verifyShareToken } from '@/shareToken'
import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import type { LensRecord } from './run'
import { uuidPrefixRange } from './uuidPrefix'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// A truncated path id → the full lens id it canonically means, or null. The
// service role on purpose: a short link must name the same lens for EVERY
// viewer, and resolving through RLS would let each caller's visibility pick a
// different prefix-match (a signed ?share= could then verify against the
// wrong row). This resolves the name only — the caller still puts the full id
// through the same RLS/signature doors as an untruncated URL, so it widens
// access to nothing. Ties break to the oldest created_at, which is stable:
// a lens created later can never capture an already-working short link.
const expandLensId = async (prefix: string): Promise<string | null> => {
  const range = uuidPrefixRange(prefix)
  if (!range) return null
  const service = createServiceClient()
  const { data } = await service
    .from('lens')
    .select('id')
    .gte('id', range.low)
    .lte('id', range.high)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle<{ id: string }>()
  return data?.id ?? null
}

export type ResolvedLens = { lens: LensRecord; viewerIsOwner: boolean }

const resolveSignedLens = async (lensId: string, param: string): Promise<LensRecord | null> => {
  const { shareId, signature } = parseShareParam(param)
  if (signature === '') return null
  // A legacy link names the lens it was issued for; it has to be this one.
  if (shareId !== null && shareId !== lensId) return null

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
  const id = UUID_RE.test(lensId) ? lensId.toLowerCase() : await expandLensId(lensId)
  if (id === null) return null

  const supabase = await createClient()
  const { data: auth } = await supabase.auth.getUser()
  const viewerId = auth?.user?.id ?? null

  // RLS is the authority for the membership/public/owner doors.
  const { data: rlsLens } = await supabase.from('lens').select('*').eq('id', id).maybeSingle<LensRecord>()

  const lens = rlsLens ?? (shareParam ? await resolveSignedLens(id, shareParam) : null)
  if (!lens) return null
  if (!(await hasFlag(lens.user_id, LENS_FLAG))) return null

  return { lens, viewerIsOwner: viewerId !== null && viewerId === lens.user_id }
}
