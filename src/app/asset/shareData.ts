// Server-side fetch of everything the share dialog needs on first paint: the
// caller's existing share row for an item, the corporations/alliances they may
// aim it at, and whether a legacy shared_asset_token link still exists.
// Returns null unless the caller OWNS the item as a character asset — mere
// RLS visibility isn't ownership any more, since phase 2 made shared items
// visible to their audience too; ownership is proven by the item's
// registration_id appearing in the caller's own registration rows (an
// RLS-scoped read that only ever returns their own).
import type { SupabaseClient } from '@supabase/supabase-js'

import { signShare, tokenSalt } from '@/shareToken'

export type ShareAudienceOption = { id: number; name: string }

export type ShareState = {
  corporationIds: number[]
  allianceIds: number[]
  hasLink: boolean
  // `<shareId>.<signature>` for the ?share= param, when a link is enabled.
  shareParam: string | null
  isPublic: boolean
}

export type ShareDialogData = {
  share: ShareState | null
  corporations: ShareAudienceOption[]
  alliances: ShareAudienceOption[]
  hasLegacyToken: boolean
}

export const fetchShareDialogData = async (
  supabase: SupabaseClient,
  itemId: string
): Promise<ShareDialogData | null> => {
  const [{ data: item }, { data: regs }] = await Promise.all([
    supabase
      .from('character_asset')
      .select('item_id, registration_id')
      .eq('item_id', itemId)
      .maybeSingle<{ item_id: number | string; registration_id: string }>(),
    supabase.from('registration').select('id, corporation_id'),
  ])
  const own = (regs ?? []) as Array<{ id: string; corporation_id: number | string | null }>
  if (!item || !own.some((r) => r.id === item.registration_id)) return null

  // The audiences on offer: the corporations the caller's characters are in,
  // and those corporations' alliances — same derivation the den share uses.
  const corpIds = [
    ...new Set(
      own
        .map((r) => r.corporation_id)
        .filter((c): c is number => c != null)
        .map(Number)
    ),
  ]
  const { data: corps } = corpIds.length
    ? await supabase.from('corporation').select('corporation_id, name, alliance_id').in('corporation_id', corpIds)
    : { data: [] }
  const corpRows = (corps ?? []) as Array<{
    corporation_id: number | string
    name: string | null
    alliance_id: number | string | null
  }>
  const corporations: ShareAudienceOption[] = corpIds
    .map((id) => ({
      id,
      name: corpRows.find((c) => Number(c.corporation_id) === id)?.name ?? `Corporation #${id}`,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))

  const allianceIds = [
    ...new Set(
      corpRows
        .map((c) => c.alliance_id)
        .filter((a): a is number => a != null)
        .map(Number)
    ),
  ]
  const { data: alliancesData } = allianceIds.length
    ? await supabase.from('alliance').select('alliance_id, name').in('alliance_id', allianceIds)
    : { data: [] }
  const allianceRows = (alliancesData ?? []) as Array<{ alliance_id: number | string; name: string | null }>
  const alliances: ShareAudienceOption[] = allianceIds
    .map((id) => ({
      id,
      name: allianceRows.find((a) => Number(a.alliance_id) === id)?.name ?? `Alliance #${id}`,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))

  const { data: shareRow } = await supabase
    .from('character_asset_share')
    .select('id, corporation_ids, alliance_ids, secret')
    .eq('registration_id', item.registration_id)
    .eq('item_id', itemId)
    .maybeSingle<{ id: string; corporation_ids: number[]; alliance_ids: number[]; secret: string | null }>()

  let share: ShareState | null = null
  if (shareRow) {
    // Signing is server-only (secret + TOKEN_SALT never reach the client);
    // a deployment without its salt just shows the link as unavailable.
    let shareParam: string | null = null
    if (shareRow.secret) {
      try {
        shareParam = `${shareRow.id}.${signShare(shareRow.id, shareRow.secret, tokenSalt())}`
      } catch {
        shareParam = null
      }
    }
    const corporationIds = (shareRow.corporation_ids ?? []).map(Number)
    const allianceIdsOnRow = (shareRow.alliance_ids ?? []).map(Number)
    share = {
      corporationIds,
      allianceIds: allianceIdsOnRow,
      hasLink: shareRow.secret != null,
      shareParam,
      isPublic: shareRow.secret == null && corporationIds.length === 0 && allianceIdsOnRow.length === 0,
    }
  }

  const { data: legacy } = await supabase
    .from('shared_asset_token')
    .select('token')
    .eq('item_id', itemId)
    .maybeSingle<{ token: string }>()

  return { share, corporations, alliances, hasLegacyToken: legacy != null }
}
