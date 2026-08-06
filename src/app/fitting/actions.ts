'use server'

import { revalidatePath } from 'next/cache'

import { mintShareSecret, signShare, tokenSalt } from '@/shareToken'
import { createClient } from '@/utils/supabase/server'
import type { SaveShareInput, SaveShareResult } from '../asset/shareActions'

// Create/update/revoke the caller's share for one fitting — the writer behind
// the share dialog on /fitting/[characterId]/[fittingId], mirroring the asset
// share actions over the unified character_fitting_share row
// (docs/sharing-layer/05-supersede-fittings.md). Cookie-session client, never
// the service role. The per-level createFittingShare/revokeFittingShare pair
// (and the three-toggle shareControls) retired with the level column.

// Ownership + audience guard: the registration must be the CALLER's (RLS on
// `registration` only ever returns their own rows), the fit must exist, and
// requested audience ids are filtered to affiliations the caller actually
// has, so a hand-rolled request can't aim a share at a third party.
const ownFitting = async (
  supabase: Awaited<ReturnType<typeof createClient>>,
  registrationId: string,
  fittingId: string
) => {
  const [{ data: regs }, { data: fit }] = await Promise.all([
    supabase.from('registration').select('id, corporation_id'),
    supabase
      .from('character_fitting')
      .select('fitting_id')
      .eq('registration_id', registrationId)
      .eq('fitting_id', fittingId)
      .maybeSingle<{ fitting_id: number | string }>(),
  ])
  const own = (regs ?? []) as Array<{ id: string; corporation_id: number | string | null }>
  if (!fit || !own.some((r) => r.id === registrationId)) return null
  const corpIds = [
    ...new Set(
      own
        .map((r) => r.corporation_id)
        .filter((c): c is number => c != null)
        .map(Number)
    ),
  ]
  const { data: corps } = corpIds.length
    ? await supabase.from('corporation').select('corporation_id, alliance_id').in('corporation_id', corpIds)
    : { data: [] }
  const allianceIds = [
    ...new Set(
      ((corps ?? []) as Array<{ alliance_id: number | string | null }>)
        .map((c) => c.alliance_id)
        .filter((a): a is number => a != null)
        .map(Number)
    ),
  ]
  return { ownCorpIds: new Set(corpIds), ownAllianceIds: new Set(allianceIds) }
}

export const saveFittingShare = async (
  registrationId: string,
  fittingId: string,
  input: SaveShareInput
): Promise<SaveShareResult> => {
  const supabase = await createClient()

  const { data: auth, error: userError } = await supabase.auth.getUser()
  if (userError || !auth?.user) return { error: 'Not signed in' }

  const owned = await ownFitting(supabase, registrationId, fittingId)
  if (!owned) return { error: 'Not your fitting' }

  const corporationIds = input.isPublic
    ? []
    : [...new Set(input.corporationIds.map(Number))].filter((id) => owned.ownCorpIds.has(id))
  const allianceIds = input.isPublic
    ? []
    : [...new Set(input.allianceIds.map(Number))].filter((id) => owned.ownAllianceIds.has(id))
  const link = input.isPublic ? false : input.link

  let salt: string | null = null
  if (link) {
    try {
      salt = tokenSalt()
    } catch {
      return { error: 'Share links are unavailable: TOKEN_SALT is not configured.' }
    }
  }

  const { data: existing } = await supabase
    .from('character_fitting_share')
    .select('id, secret')
    .eq('registration_id', registrationId)
    .eq('fitting_id', fittingId)
    .maybeSingle<{ id: string; secret: string | null }>()

  const secret = link ? (input.rotateLink || !existing?.secret ? mintShareSecret() : existing.secret) : null

  const { data: saved, error } = await supabase
    .from('character_fitting_share')
    .upsert(
      {
        registration_id: registrationId,
        fitting_id: Number(fittingId),
        corporation_ids: corporationIds,
        alliance_ids: allianceIds,
        secret,
      },
      { onConflict: 'registration_id,fitting_id' }
    )
    .select('id')
    .maybeSingle<{ id: string }>()
  if (error || !saved) return { error: error?.message ?? 'Save failed' }

  revalidatePath('/fitting')

  return {
    share: {
      corporationIds,
      allianceIds,
      hasLink: secret != null,
      shareParam: secret != null && salt != null ? signShare(saved.id, secret, salt) : null,
      isPublic: secret == null && corporationIds.length === 0 && allianceIds.length === 0,
    },
  }
}

export const revokeFittingShare = async (registrationId: string, fittingId: string): Promise<{ error?: string }> => {
  const supabase = await createClient()

  const { data: auth, error: userError } = await supabase.auth.getUser()
  if (userError || !auth?.user) return { error: 'Not signed in' }

  // RLS scopes the delete to the caller's own rows.
  const { error } = await supabase
    .from('character_fitting_share')
    .delete()
    .eq('registration_id', registrationId)
    .eq('fitting_id', fittingId)
  if (error) return { error: error.message }

  revalidatePath('/fitting')
  return {}
}
