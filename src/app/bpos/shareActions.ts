'use server'

import { revalidatePath } from 'next/cache'

import { mintShareSecret, signShare, tokenSalt } from '@/shareToken'
import { createClient } from '@/utils/supabase/server'

import type { SaveShareInput, SaveShareResult } from '../asset/shareActions'

// Create/update/revoke the caller's BPO showcase share — the writer behind the
// share dialog on /bpos/[name], mirroring the asset and fitting share actions
// over the one user_id-keyed bpo_share row. Cookie-session client, never the
// service role: the table's own policy pins user_id to the caller.

// The affiliations a share may be aimed at. Requested ids are filtered against
// these so a hand-rolled request can't aim a share at a corporation the caller
// has no character in.
const ownAudiences = async (supabase: Awaited<ReturnType<typeof createClient>>) => {
  const { data: regs } = await supabase.from('registration').select('id, corporation_id')
  const corpIds = [
    ...new Set(
      ((regs ?? []) as Array<{ corporation_id: number | string | null }>)
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

export const saveBposShare = async (slug: string, input: SaveShareInput): Promise<SaveShareResult> => {
  const supabase = await createClient()

  const { data: auth, error: userError } = await supabase.auth.getUser()
  if (userError || !auth?.user) return { error: 'Not signed in' }

  const owned = await ownAudiences(supabase)

  const corporationIds = input.isPublic
    ? []
    : [...new Set(input.corporationIds.map(Number))].filter((id) => owned.ownCorpIds.has(id))
  const allianceIds = input.isPublic
    ? []
    : [...new Set(input.allianceIds.map(Number))].filter((id) => owned.ownAllianceIds.has(id))
  const link = input.isPublic ? false : input.link

  // Signing requires the deployment's salt; fail before writing anything.
  let salt: string | null = null
  if (link) {
    try {
      salt = tokenSalt()
    } catch {
      return { error: 'Share links are unavailable: TOKEN_SALT is not configured.' }
    }
  }

  const { data: existing } = await supabase.from('bpo_share').select('id, secret').maybeSingle<{
    id: string
    secret: string | null
  }>()

  const secret = link ? (input.rotateLink || !existing?.secret ? mintShareSecret() : existing.secret) : null

  const { data: saved, error } = await supabase
    .from('bpo_share')
    .upsert(
      {
        user_id: auth.user.id,
        corporation_ids: corporationIds,
        alliance_ids: allianceIds,
        secret,
      },
      { onConflict: 'user_id' }
    )
    .select('id')
    .maybeSingle<{ id: string }>()
  if (error || !saved) return { error: error?.message ?? 'Save failed' }

  revalidatePath(`/bpos/${slug}`)

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

export const revokeBposShare = async (slug: string): Promise<{ error?: string }> => {
  const supabase = await createClient()

  const { data: auth, error: userError } = await supabase.auth.getUser()
  if (userError || !auth?.user) return { error: 'Not signed in' }

  // RLS scopes the delete to the caller's own row.
  const { error } = await supabase.from('bpo_share').delete().eq('user_id', auth.user.id)
  if (error) return { error: error.message }

  revalidatePath(`/bpos/${slug}`)
  return {}
}
