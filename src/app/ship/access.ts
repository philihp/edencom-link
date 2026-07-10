// Resolves a share token (shared_asset_token) into the sharing user's asset
// visibility scope. Share links let anonymous visitors view one specific
// item/hangar, so this runs on the service-role client — which bypasses RLS —
// and every caller MUST therefore scope its asset queries to the returned
// character/corporation ids. A token only resolves for the exact id in the
// URL, and dies naturally when the sharer unlinks their characters (or the
// row is revoked/deleted).
import { createServiceClient } from '@/utils/supabase/service'

export type ShareScope = {
  userId: string
  // registration uuids (character_asset.character_id values) of the sharer
  characterIds: string[]
  // character name per registration uuid, for owner display
  characterNames: Map<string, string>
  // EVE corporation ids the sharer's characters belong to (corp_asset scope)
  corporationIds: number[]
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
    characterIds: rows.map((r) => r.id),
    characterNames: new Map(rows.map((r) => [r.id, r.name])),
    corporationIds: [...new Set(rows.filter((r) => r.corporation_id != null).map((r) => Number(r.corporation_id)))],
  }
}
