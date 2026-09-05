// Viewer authorization for /link/[id] and its CSV route. Two doors, same as
// every Revision 3 share subject:
//
// - RLS: the caller's cookie client reads the link row directly — the owner
//   policy or the audience policy (corporation/alliance membership, or a
//   fully-public shared link) decides. Works signed-out too: the anon role
//   reaches only shared-and-public rows.
// - Signed link: ?share=<signature> verified against the row's secret +
//   TOKEN_SALT via the service client (an anonymous HTTP request is invisible
//   to RLS — a Link issued by signed URL alone matches no one there by
//   design). The Link the signature must verify against is the one in the
//   path, so the token needn't name it; legacy `<linkId>.<signature>` URLs
//   still resolve, and the viewer rewrites them to the short form in the
//   address bar.
//
// The path id may be truncated (any canonical-format prefix of ≥8 hex digits,
// e.g. /link/da204490): it expands to the oldest-created matching link before
// either door is tried — see expandLinkId.
import { parseShareParam, tokenSalt, verifyShareToken } from '@/shareToken'
import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import type { LinkRecord } from './run'
import { uuidPrefixRange } from './uuidPrefix'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// A truncated path id → the full link id it canonically means, or null. The
// service role on purpose: a short link must name the same link for EVERY
// viewer, and resolving through RLS would let each caller's visibility pick a
// different prefix-match (a signed ?share= could then verify against the
// wrong row). This resolves the name only — the caller still puts the full id
// through the same RLS/signature doors as an untruncated URL, so it widens
// access to nothing. Ties break to the oldest created_at, which is stable:
// a link created later can never capture an already-working short link.
const expandLinkId = async (prefix: string): Promise<string | null> => {
  const range = uuidPrefixRange(prefix)
  if (!range) return null
  const service = createServiceClient()
  const { data } = await service
    .from('link')
    .select('id')
    .gte('id', range.low)
    .lte('id', range.high)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle<{ id: string }>()
  return data?.id ?? null
}

export type ResolvedLink = { link: LinkRecord; viewerIsOwner: boolean }

const resolveSignedLink = async (linkId: string, param: string): Promise<LinkRecord | null> => {
  const { shareId, signature } = parseShareParam(param)
  if (signature === '') return null
  // A legacy link names the link it was issued for; it has to be this one.
  if (shareId !== null && shareId !== linkId) return null

  let salt: string
  try {
    salt = tokenSalt()
  } catch {
    return null
  }

  const service = createServiceClient()
  const { data: link } = await service.from('link').select('*').eq('id', linkId).maybeSingle<LinkRecord>()
  if (!link || !link.enabled || !link.secret) return null
  return verifyShareToken(link.id, link.secret, salt, signature) ? link : null
}

export const resolveLink = async (linkId: string, shareParam?: string): Promise<ResolvedLink | null> => {
  const id = UUID_RE.test(linkId) ? linkId.toLowerCase() : await expandLinkId(linkId)
  if (id === null) return null

  const supabase = await createClient()
  const { data: auth } = await supabase.auth.getUser()
  const viewerId = auth?.user?.id ?? null

  // RLS is the authority for the membership/public/owner doors.
  const { data: rlsLink } = await supabase.from('link').select('*').eq('id', id).maybeSingle<LinkRecord>()

  const link = rlsLink ?? (shareParam ? await resolveSignedLink(id, shareParam) : null)
  if (!link) return null

  return { link, viewerIsOwner: viewerId !== null && viewerId === link.user_id }
}
