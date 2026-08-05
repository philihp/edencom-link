// Server-side fetch of everything the share dialog needs on first paint: the
// caller's existing share row for a subject, the corporations/alliances they
// may aim it at, and (for assets) whether a legacy shared_asset_token link
// still exists. The audience/state helpers are exported for the other share
// subjects (fittings today) so every dialog is fed the same shapes.
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

export type OwnRegistration = { id: string; corporation_id: number | string | null }

// The audiences a share may be aimed at: the corporations the caller's
// characters are in, and those corporations' alliances — same derivation the
// den share uses, with names from the world-readable corporation/alliance
// directories.
export const fetchShareAudiences = async (
  supabase: SupabaseClient,
  own: OwnRegistration[]
): Promise<{ corporations: ShareAudienceOption[]; alliances: ShareAudienceOption[] }> => {
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

  return { corporations, alliances }
}

export type ShareRowLike = {
  id: string
  corporation_ids: number[] | null
  alliance_ids: number[] | null
  secret: string | null
}

// A share row → the dialog's view of it, with the signed ?share= param when a
// link is enabled. Signing is server-only (secret + TOKEN_SALT never reach
// the client); a deployment without its salt just shows the link unavailable.
export const shareRowToState = (row: ShareRowLike | null): ShareState | null => {
  if (!row) return null
  let shareParam: string | null = null
  if (row.secret) {
    try {
      shareParam = `${row.id}.${signShare(row.id, row.secret, tokenSalt())}`
    } catch {
      shareParam = null
    }
  }
  const corporationIds = (row.corporation_ids ?? []).map(Number)
  const allianceIds = (row.alliance_ids ?? []).map(Number)
  return {
    corporationIds,
    allianceIds,
    hasLink: row.secret != null,
    shareParam,
    isPublic: row.secret == null && corporationIds.length === 0 && allianceIds.length === 0,
  }
}

// Returns null unless the caller OWNS the item as a character asset — mere
// RLS visibility isn't ownership any more, since phase 2 made shared items
// visible to their audience too; ownership is proven by the item's
// registration_id appearing in the caller's own registration rows (an
// RLS-scoped read that only ever returns their own).
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
  const own = (regs ?? []) as OwnRegistration[]
  if (!item || !own.some((r) => r.id === item.registration_id)) return null

  const { corporations, alliances } = await fetchShareAudiences(supabase, own)

  const { data: shareRow } = await supabase
    .from('character_asset_share')
    .select('id, corporation_ids, alliance_ids, secret')
    .eq('registration_id', item.registration_id)
    .eq('item_id', itemId)
    .maybeSingle<ShareRowLike>()

  const { data: legacy } = await supabase
    .from('shared_asset_token')
    .select('token')
    .eq('item_id', itemId)
    .maybeSingle<{ token: string }>()

  return { share: shareRowToState(shareRow), corporations, alliances, hasLegacyToken: legacy != null }
}
