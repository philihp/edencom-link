// Resolves share links into the sharing user's asset visibility scope, for
// anonymous visitors. Both forms run on the service-role client — which
// bypasses RLS — so every caller MUST scope its asset queries to the returned
// registration/corporation ids.
//
// Two link generations live here:
//  - resolveSignedShare: the sharing layer's ?share=<signature>
//    (docs/sharing-layer/03-share-dialog.md). The signature is an HMAC over
//    the share id keyed by the row's secret + TOKEN_SALT (src/shareToken.ts),
//    and the link is RECURSIVE: it opens the share's subject item and
//    anything nested inside it — so the candidate rows are the shares whose
//    subject is the requested item or one of its ancestors, and the signature
//    picks which of those (if any) the link was issued for. Legacy
//    `<shareId>.<signature>` links narrow that candidate set to the named row.
//  - resolveShareToken: the legacy shared_asset_token ?token=… link, kept
//    resolving through a deprecation window (no UI mints these any more;
//    saving a share from the dialog retires the item's legacy row). Exact-id
//    only, as it always was.
import { parseShareParam, tokenSalt, verifyShareToken } from '@/shareToken'
import { createServiceClient } from '@/utils/supabase/service'

export type ShareScope = {
  userId: string
  // registration uuids (character_asset.registration_id values) of the sharer
  registrationIds: string[]
  // character name per registration uuid, for owner display
  characterNames: Map<string, string>
  // EVE corporation ids the sharer's characters belong to (corp_asset scope)
  corporationIds: number[]
}

// `from` itself followed by its enclosing containers — climbing best-known
// parents one indexed probe at a time, depth-capped to match
// asset_ancestors()/asset_share_covers(). Every id a recursive share could
// have been issued for and still cover `from`. Service client: the anonymous
// caller has no RLS visibility yet, that's the point of the walk.
const ancestryChain = async (
  supabase: ReturnType<typeof createServiceClient>,
  from: string,
  acc: string[] = []
): Promise<string[]> => {
  const chain = [...acc, from]
  if (chain.length > 16) return chain
  const { data } = await supabase
    .from('character_asset_over_time')
    .select('location_id')
    .eq('item_id', from)
    .order('is_current', { ascending: false })
    .order('valid_until', { ascending: false })
    .limit(1)
    .maybeSingle<{ location_id: number | string | null }>()
  const parent = data?.location_id
  return parent == null ? chain : ancestryChain(supabase, String(parent), chain)
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const resolveSignedShare = async (param: string, itemId: string): Promise<ShareScope | null> => {
  const { shareId, signature } = parseShareParam(param)
  if (signature === '') return null
  if (shareId !== null && !UUID_RE.test(shareId)) return null

  // A deployment without its salt can't verify anything — treat as no share
  // rather than throwing into the page.
  let salt: string
  try {
    salt = tokenSalt()
  } catch {
    return null
  }

  // Every share that covers the requested item, then the signature says which
  // one (if any) minted this link. A legacy link's id narrows it to one row.
  const supabase = createServiceClient()
  const chain = await ancestryChain(supabase, itemId)
  const query = supabase.from('character_asset_share').select('id, registration_id, secret').in('item_id', chain)
  const { data: covering } = await (shareId === null ? query : query.eq('id', shareId))
  const share = ((covering ?? []) as Array<{ id: string; registration_id: string; secret: string | null }>).find(
    (row) => row.secret != null && verifyShareToken(row.id, row.secret, salt, signature)
  )
  if (!share) return null

  const { data: registration } = await supabase
    .from('registration')
    .select('id, name, user_id')
    .eq('id', share.registration_id)
    .maybeSingle<{ id: string; name: string; user_id: string }>()
  if (!registration) return null

  return {
    userId: registration.user_id,
    registrationIds: [registration.id],
    characterNames: new Map([[registration.id, registration.name]]),
    // Asset shares are character-scoped (docs/sharing-layer/02-recursive-rls.md);
    // corp assets never ride a signed link.
    corporationIds: [],
  }
}

export const resolveShareToken = async (token: string, itemId: string): Promise<ShareScope | null> => {
  const supabase = createServiceClient()

  const { data: share } = await supabase
    .from('shared_asset_token')
    .select('user_id, item_id')
    .eq('token', token)
    .maybeSingle<{ user_id: string; item_id: number | string }>()
  if (!share || String(share.item_id) !== itemId) return null

  const { data: registrations } = await supabase
    .from('registration')
    .select('id, name, corporation_id')
    .eq('user_id', share.user_id)
  const rows = (registrations ?? []) as Array<{ id: string; name: string; corporation_id: number | string | null }>
  if (rows.length === 0) return null

  return {
    userId: share.user_id,
    registrationIds: rows.map((r) => r.id),
    characterNames: new Map(rows.map((r) => [r.id, r.name])),
    corporationIds: [...new Set(rows.filter((r) => r.corporation_id != null).map((r) => Number(r.corporation_id)))],
  }
}

// The one entry point pages use: signed links first, then legacy tokens.
export const resolveShareParams = async (
  { share, token }: { share?: string; token?: string },
  itemId: string
): Promise<ShareScope | null> =>
  share ? resolveSignedShare(share, itemId) : token ? resolveShareToken(token, itemId) : null
