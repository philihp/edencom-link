'use server'

import { revalidatePath } from 'next/cache'

import { mintShareSecret, signShare, tokenSalt } from '@/shareToken'
import { createClient } from '@/utils/supabase/server'

import type { SaveShareInput, SaveShareResult } from '../asset/shareActions'
import { directorOf } from './directors'

// Create/update/revoke a corporation's structure share — the writers behind
// the Share dialog on /structure/[structureId] and the alliance toggle on
// /structure (docs/sharing-layer/12-structure-share.md). Cookie-session
// client like every share writer here, never the service role: the share
// table's "Directors manage structure shares" policy is what pins a write to
// a director of the owning corporation, and `updated_by` to one of their own
// characters; the checks here only turn a refused write into a plain message.

type Supabase = Awaited<ReturnType<typeof createClient>>

// The audiences a director may name: the corporations the caller's characters
// are in and those corporations' alliances — so a hand-rolled request cannot
// aim a share at a third party.
const ownAudiences = async (supabase: Supabase) => {
  const { data: regs } = await supabase.from('registration').select('corporation_id')
  const corpIds = [
    ...new Set(
      ((regs ?? []) as Array<{ corporation_id: number | string | null }>)
        .map((r) => r.corporation_id)
        .filter((c): c is number => c != null)
        .map(Number)
    ),
  ]
  const { data: corps } = corpIds.length
    ? await supabase.from('corporation').select('alliance_id').in('corporation_id', corpIds)
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

const owningCorporation = async (supabase: Supabase, structureId: string): Promise<number | null> => {
  const { data } = await supabase
    .from('corp_structure')
    .select('corporation_id')
    .eq('structure_id', structureId)
    .maybeSingle<{ corporation_id: number | string }>()
  return data ? Number(data.corporation_id) : null
}

export const saveStructureShare = async (structureId: string, input: SaveShareInput): Promise<SaveShareResult> => {
  const supabase = await createClient()

  const { data: auth, error: userError } = await supabase.auth.getUser()
  if (userError || !auth?.user) return { error: 'Not signed in' }

  const corporationId = await owningCorporation(supabase, structureId)
  if (corporationId == null) return { error: 'No such structure' }
  const director = await directorOf(supabase, corporationId)
  if (!director) return { error: 'Only a director of the owning corporation can share a structure' }

  const { ownCorpIds, ownAllianceIds } = await ownAudiences(supabase)
  const corporationIds = input.isPublic
    ? []
    : [...new Set(input.corporationIds.map(Number))].filter((id) => ownCorpIds.has(id))
  const allianceIds = input.isPublic
    ? []
    : [...new Set(input.allianceIds.map(Number))].filter((id) => ownAllianceIds.has(id))
  const link = input.isPublic ? false : input.link
  // Public already reaches every tenant; the flag then says nothing.
  const tenants = input.isPublic ? false : input.tenants === true

  // Signing requires the deployment's salt; fail before writing anything.
  let salt: string | null = null
  if (link) {
    try {
      salt = tokenSalt()
    } catch {
      return { error: 'Share links are unavailable: TOKEN_SALT is not configured.' }
    }
  }

  const { data: existing } = await supabase
    .from('corp_structure_share')
    .select('id, secret')
    .eq('corporation_id', corporationId)
    .eq('structure_id', structureId)
    .maybeSingle<{ id: string; secret: string | null }>()

  const secret = link ? (input.rotateLink || !existing?.secret ? mintShareSecret() : existing.secret) : null
  const now = new Date().toISOString()
  // A director's save is never the seeded default: the arrays now pin ids.
  const audience = {
    corporation_ids: corporationIds,
    alliance_ids: allianceIds,
    secret,
    tenants,
    seeded_default: false,
    updated_by: director.registrationId,
    updated_at: now,
  }

  const { data: saved, error } = existing
    ? await supabase
        .from('corp_structure_share')
        .update(audience)
        .eq('id', existing.id)
        .select('id')
        .maybeSingle<{ id: string }>()
    : await supabase
        .from('corp_structure_share')
        .insert({ corporation_id: corporationId, structure_id: Number(structureId), ...audience })
        .select('id')
        .maybeSingle<{ id: string }>()
  if (error || !saved) return { error: error?.message ?? 'Save failed' }

  revalidatePath(`/structure/${structureId}`)
  revalidatePath('/structure')

  return {
    share: {
      corporationIds,
      allianceIds,
      hasLink: secret != null,
      shareParam: secret != null && salt != null ? signShare(saved.id, secret, salt) : null,
      isPublic: secret == null && corporationIds.length === 0 && allianceIds.length === 0 && !tenants,
      tenants,
    },
  }
}

export const revokeStructureShare = async (structureId: string): Promise<{ error?: string }> => {
  const supabase = await createClient()

  const { data: auth, error: userError } = await supabase.auth.getUser()
  if (userError || !auth?.user) return { error: 'Not signed in' }

  // RLS scopes the delete to corporations the caller directs.
  const { error } = await supabase.from('corp_structure_share').delete().eq('structure_id', structureId)
  if (error) return { error: error.message }

  revalidatePath(`/structure/${structureId}`)
  revalidatePath('/structure')
  return {}
}

// The /structure toggle: "Share all structures with <alliance>". On re-inserts
// the corporation-wide row as the seeded default (so the extract keeps it on
// the corp's current alliance); off deletes it — the opt-out the seed-once
// rule respects.
export const setAllianceShareDefault = async (corporationId: number, enabled: boolean): Promise<{ error?: string }> => {
  const supabase = await createClient()

  const { data: auth, error: userError } = await supabase.auth.getUser()
  if (userError || !auth?.user) return { error: 'Not signed in' }

  const director = await directorOf(supabase, Number(corporationId))
  if (!director) return { error: 'Only a director can change this' }

  if (!enabled) {
    const { error } = await supabase
      .from('corp_structure_share')
      .delete()
      .eq('corporation_id', Number(corporationId))
      .is('structure_id', null)
    if (error) return { error: error.message }
  } else {
    const { data: corp } = await supabase
      .from('corporation')
      .select('alliance_id')
      .eq('corporation_id', Number(corporationId))
      .maybeSingle<{ alliance_id: number | string | null }>()
    if (corp?.alliance_id == null) return { error: 'This corporation is not in an alliance' }
    const row = {
      alliance_ids: [Number(corp.alliance_id)],
      corporation_ids: [],
      secret: null,
      tenants: false,
      seeded_default: true,
      updated_by: director.registrationId,
      updated_at: new Date().toISOString(),
    }
    const { data: existing } = await supabase
      .from('corp_structure_share')
      .select('id')
      .eq('corporation_id', Number(corporationId))
      .is('structure_id', null)
      .maybeSingle<{ id: string }>()
    const { error } = existing
      ? await supabase.from('corp_structure_share').update(row).eq('id', existing.id)
      : await supabase
          .from('corp_structure_share')
          .insert({ corporation_id: Number(corporationId), structure_id: null, ...row })
    if (error) return { error: error.message }
  }

  revalidatePath('/structure')
  return {}
}
