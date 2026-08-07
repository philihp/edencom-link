// Writing a lens's audience: the one implementation behind both the editor's
// share dialog (via the server action in ./actions.ts) and the MCP
// `create_lens` tool.
//
// Factored out of actions.ts rather than left there because a 'use server'
// module exports server actions, not helpers — the MCP layer needs the logic,
// not a callable action. Nothing here authorizes anybody: callers establish
// who the user is (cookie session or bearer token) and that they hold the lens
// flag, then hand in a client whose RLS pins the write to them.
import type { SupabaseClient } from '@supabase/supabase-js'

import type { ShareState } from '@/app/asset/shareData'
import { mintShareSecret, signShare, tokenSalt } from '@/shareToken'

import type { OwnAudiences, ResolvedAudience } from './audience'

// The corporations the caller's characters are in, and those corporations'
// alliances — the only audiences a share may be aimed at. Same derivation as
// fetchShareAudiences, but ids only (the dialog needs names; a defensive
// filter doesn't) plus the names the MCP tool matches on.
export const fetchOwnAudiences = async (supabase: SupabaseClient): Promise<OwnAudiences> => {
  const { data: regs } = await supabase.from('registration').select('corporation_id')
  const corporationIds = [
    ...new Set(
      ((regs ?? []) as Array<{ corporation_id: number | string | null }>)
        .map((r) => r.corporation_id)
        .filter((c): c is number | string => c != null)
        .map(Number)
    ),
  ]
  const { data: corps } = corporationIds.length
    ? await supabase
        .from('corporation')
        .select('corporation_id, name, alliance_id')
        .in('corporation_id', corporationIds)
    : { data: [] }
  const corpRows = (corps ?? []) as Array<{
    corporation_id: number | string
    name: string | null
    alliance_id: number | string | null
  }>

  const allianceIds = [
    ...new Set(
      corpRows
        .map((c) => c.alliance_id)
        .filter((a): a is number | string => a != null)
        .map(Number)
    ),
  ]
  const { data: alliances } = allianceIds.length
    ? await supabase.from('alliance').select('alliance_id, name').in('alliance_id', allianceIds)
    : { data: [] }
  const allianceRows = (alliances ?? []) as Array<{ alliance_id: number | string; name: string | null }>

  return {
    corporations: corporationIds.map((id) => ({
      id,
      name: corpRows.find((c) => Number(c.corporation_id) === id)?.name ?? `Corporation #${id}`,
    })),
    alliances: allianceIds.map((id) => ({
      id,
      name: allianceRows.find((a) => Number(a.alliance_id) === id)?.name ?? `Alliance #${id}`,
    })),
  }
}

export type ApplyShareResult = { ok: true; share: ShareState | null } | { ok: false; message: string }

// Write a resolved audience onto a lens row the caller owns.
//
// `existingSecret` is the secret currently on the row: an existing link
// survives a re-share, unless `rotateLink` mints a fresh secret, which
// invalidates every URL ever issued for this lens.
export const applyLensShare = async (
  supabase: SupabaseClient,
  userId: string,
  lensId: string,
  audience: ResolvedAudience,
  { existingSecret, rotateLink = false }: { existingSecret: string | null; rotateLink?: boolean }
): Promise<ApplyShareResult> => {
  // Not shared at all is a distinct state from shared-with-nobody: the latter
  // is how this table spells "public", so it must never be reached by accident.
  if (!audience.shared) {
    const { error } = await supabase
      .from('lens')
      .update({ enabled: false, corporation_ids: [], alliance_ids: [], secret: null })
      .eq('id', lensId)
      .eq('user_id', userId)
    return error ? { ok: false, message: error.message } : { ok: true, share: null }
  }

  let salt: string | null = null
  if (audience.link) {
    try {
      salt = tokenSalt()
    } catch {
      return { ok: false, message: 'Share links are unavailable: TOKEN_SALT is not configured.' }
    }
  }

  const secret = audience.link ? (rotateLink || !existingSecret ? mintShareSecret() : existingSecret) : null

  const { error } = await supabase
    .from('lens')
    .update({
      enabled: true,
      corporation_ids: audience.corporationIds,
      alliance_ids: audience.allianceIds,
      secret,
    })
    .eq('id', lensId)
    .eq('user_id', userId)
  if (error) return { ok: false, message: error.message }

  return {
    ok: true,
    share: {
      corporationIds: audience.corporationIds,
      allianceIds: audience.allianceIds,
      hasLink: secret != null,
      shareParam: secret != null && salt != null ? `${lensId}.${signShare(lensId, secret, salt)}` : null,
      isPublic: secret == null && audience.corporationIds.length === 0 && audience.allianceIds.length === 0,
    },
  }
}
