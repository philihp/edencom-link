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
//    An item lives in exactly ONE of the two hangars, so the character tables
//    are tried first and a corp item falls through to corp_asset_version /
//    corp_asset_share (phase 14 PR 4), verified the same way.
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
  // The share asks to show the account's main character as the owner
  // (character_asset_share.show_as_main). Legacy ?token= links never do.
  showAsMain: boolean
}

// `from` itself followed by its enclosing containers and, last, the root's
// place — climbing best-known parents one indexed probe at a time, depth-capped
// to match asset_ancestors()/asset_share_covers(). Every id a recursive share
// could have been issued for and still cover `from`, a place share
// (docs/sharing-layer/15-place-share.md) included: the service client reads the
// root's place through the view, which is what puts it at the end. Service
// client: the anonymous caller has no RLS visibility yet, that's the point of
// the walk. `holder` is the owner of `from` itself, or null when `from` is no
// item of this hangar (a place, or the other hangar's item).
const ancestryChain = async (
  supabase: ReturnType<typeof createServiceClient>,
  table: 'character_asset_over_time' | 'corp_asset_over_time',
  from: string,
  acc: string[] = [],
  holder: string | null = null
): Promise<{ chain: string[]; holder: string | null }> => {
  const chain = [...acc, from]
  if (chain.length > 16) return { chain, holder }
  const owner = table === 'character_asset_over_time' ? 'registration_id' : 'corporation_id'
  const { data } = await supabase
    .from(table)
    .select(`location_id, ${owner}`)
    .eq('item_id', from)
    .order('is_current', { ascending: false })
    .order('valid_until', { ascending: false })
    .limit(1)
    .maybeSingle<{ location_id: number | string | null } & Record<string, number | string | null>>()
  const heldBy = acc.length === 0 && data?.[owner] != null ? String(data[owner]) : holder
  const parent = data?.location_id
  return parent == null ? { chain, holder: heldBy } : ancestryChain(supabase, table, String(parent), chain, heldBy)
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
  // A share covers only its grantor's own items, so when the item is a
  // character's, only that character's shares are candidates — a place share
  // by another owner at the same place never opens it.
  const { chain, holder } = await ancestryChain(supabase, 'character_asset_over_time', itemId)
  const candidates = supabase
    .from('character_asset_share')
    .select('id, registration_id, secret, show_as_main')
    .in('item_id', chain)
  const byHolder = holder === null ? candidates : candidates.eq('registration_id', holder)
  const { data: covering } = await (shareId === null ? byHolder : byHolder.eq('id', shareId))
  const share = (
    (covering ?? []) as Array<{ id: string; registration_id: string; secret: string | null; show_as_main: boolean }>
  ).find((row) => row.secret != null && verifyShareToken(row.id, row.secret, salt, signature))
  // Not a character item (or no character share minted this link): the item may
  // be a corporation's. An item is in exactly one hangar, so this is the other
  // half of the same question, not a second guess at the first.
  if (!share) return resolveSignedCorpShare(supabase, shareId, signature, salt, itemId)

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
    // A character asset share is character-scoped
    // (docs/sharing-layer/02-recursive-rls.md); the corp arm below is the one
    // that opens corp rows.
    corporationIds: [],
    showAsMain: share.show_as_main === true,
  }
}

// The corp arm of the signed link (phase 14 PR 4). Same walk, same signature
// check, over corp_asset_share. The scope it returns names the grantor
// CORPORATION and no registration, so every downstream query stays inside that
// corporation's rows: fetchRootItems/fetchSelf take the corp scope, the owner
// strip names the corporation, and show-as-main never applies — a corporation
// is the owner it would otherwise hide behind.
//
// `userId` is the account the share was minted from, kept only because
// ShareScope carries it; nothing in the corp path keys off it (the rows are the
// corporation's, not an account's).
const resolveSignedCorpShare = async (
  supabase: ReturnType<typeof createServiceClient>,
  shareId: string | null,
  signature: string,
  salt: string,
  itemId: string
): Promise<ShareScope | null> => {
  const { chain, holder } = await ancestryChain(supabase, 'corp_asset_over_time', itemId)
  const candidates = supabase
    .from('corp_asset_share')
    .select('id, corporation_id, created_by, secret')
    .in('item_id', chain)
  const byHolder = holder === null ? candidates : candidates.eq('corporation_id', holder)
  const { data: covering } = await (shareId === null ? byHolder : byHolder.eq('id', shareId))
  const share = (
    (covering ?? []) as Array<{
      id: string
      corporation_id: number | string
      created_by: string | null
      secret: string | null
    }>
  ).find((row) => row.secret != null && verifyShareToken(row.id, row.secret, salt, signature))
  if (!share) return null

  // The author's account, when the row still names a registration (created_by
  // is nulled if that account closes, which must not kill the share).
  const { data: author } = share.created_by
    ? await supabase
        .from('registration')
        .select('user_id')
        .eq('id', share.created_by)
        .maybeSingle<{ user_id: string }>()
    : { data: null }

  return {
    userId: author?.user_id ?? '',
    registrationIds: [],
    characterNames: new Map(),
    corporationIds: [Number(share.corporation_id)],
    showAsMain: false,
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
    showAsMain: false,
  }
}

// The one entry point pages use: signed links first, then legacy tokens.
export const resolveShareParams = async (
  { share, token }: { share?: string; token?: string },
  itemId: string
): Promise<ShareScope | null> =>
  share ? resolveSignedShare(share, itemId) : token ? resolveShareToken(token, itemId) : null
