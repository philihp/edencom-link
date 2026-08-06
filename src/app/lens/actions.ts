'use server'

import { graphql } from 'graphql'
import { revalidatePath } from 'next/cache'

import { contextForUser } from '@/app/api/graphql/context'
import { schema } from '@/app/api/graphql/schema'
import type { SaveShareInput, SaveShareResult } from '@/app/asset/shareActions'
import { LENS_FLAG, hasFlag } from '@/flags'
import { mintShareSecret, signShare, tokenSalt } from '@/shareToken'
import { createClient } from '@/utils/supabase/server'
import { parseLensVariables, validateLensQuery } from './validate'

// Server actions behind the /lens editor (docs/sharing-layer/07-lens.md).
// Cookie-session client throughout, like every share writer: RLS pins lens
// rows to their owner. Everything here is additionally gated on the caller's
// own lens flag — the editor is dark-launched.

const flaggedUser = async (supabase: Awaited<ReturnType<typeof createClient>>): Promise<string | null> => {
  const { data: auth, error } = await supabase.auth.getUser()
  if (error || !auth?.user) return null
  return (await hasFlag(auth.user.id, LENS_FLAG)) ? auth.user.id : null
}

export type SaveLensInput = { name: string; query: string; variables: string }
export type SaveLensResult = { error?: string; id?: string }

export const saveLens = async (lensId: string | null, input: SaveLensInput): Promise<SaveLensResult> => {
  const supabase = await createClient()
  const userId = await flaggedUser(supabase)
  if (!userId) return { error: 'Not available' }

  const name = input.name.trim()
  if (name === '') return { error: 'Give the lens a name.' }

  const validation = validateLensQuery(input.query)
  if (!validation.ok) return { error: validation.message }
  const variables = parseLensVariables(input.variables)
  if (!variables.ok) return { error: variables.message }

  // RLS pins both branches to the caller: with check on insert, using on the
  // update's row match (a foreign id simply updates nothing).
  const row = { name, query: input.query, variables: variables.variables, updated_at: new Date().toISOString() }
  const { data: saved, error } = lensId
    ? await supabase.from('lens').update(row).eq('id', lensId).eq('user_id', userId).select('id').maybeSingle()
    : await supabase
        .from('lens')
        .insert({ ...row, user_id: userId })
        .select('id')
        .maybeSingle()
  if (error || !saved) return { error: error?.message ?? 'Save failed' }

  revalidatePath('/lens')
  revalidatePath(`/lens/${saved.id}`)
  return { id: saved.id as string }
}

export const deleteLens = async (lensId: string): Promise<{ error?: string }> => {
  const supabase = await createClient()
  const userId = await flaggedUser(supabase)
  if (!userId) return { error: 'Not available' }

  const { error } = await supabase.from('lens').delete().eq('id', lensId).eq('user_id', userId)
  if (error) return { error: error.message }
  revalidatePath('/lens')
  return {}
}

// Run-as-me preview for the editor: validates, then executes under the
// CALLER's own context — the same result the audience will see, since the
// caller is the creator. Doesn't require the graphql flag: the lens flag is
// the editor's gate.
export const previewLens = async (input: {
  query: string
  variables: string
}): Promise<{ error?: string; result?: string }> => {
  const supabase = await createClient()
  const userId = await flaggedUser(supabase)
  if (!userId) return { error: 'Not available' }

  const validation = validateLensQuery(input.query)
  if (!validation.ok) return { error: validation.message }
  const variables = parseLensVariables(input.variables)
  if (!variables.ok) return { error: variables.message }

  const contextValue = await contextForUser(userId)
  const result = await graphql({ schema, source: input.query, variableValues: variables.variables, contextValue })
  return {
    result: JSON.stringify({ data: result.data ?? null, errors: result.errors?.map((e) => e.message) }, null, 2),
  }
}

// The audience side, driven by the shared ShareDialog. The lens row IS the
// share row, so save/revoke toggle its `shared` flag and audience columns
// rather than upserting a sibling row. Requested audience ids are filtered to
// ones the caller actually has (the setSharedAlliances defense).
const ownAudiences = async (supabase: Awaited<ReturnType<typeof createClient>>) => {
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

export const saveLensShare = async (lensId: string, input: SaveShareInput): Promise<SaveShareResult> => {
  const supabase = await createClient()
  const userId = await flaggedUser(supabase)
  if (!userId) return { error: 'Not available' }

  const { data: existing } = await supabase
    .from('lens')
    .select('id, secret')
    .eq('id', lensId)
    .eq('user_id', userId)
    .maybeSingle<{ id: string; secret: string | null }>()
  if (!existing) return { error: 'Not your lens' }

  const own = await ownAudiences(supabase)
  const corporationIds = input.isPublic
    ? []
    : [...new Set(input.corporationIds.map(Number))].filter((id) => own.ownCorpIds.has(id))
  const allianceIds = input.isPublic
    ? []
    : [...new Set(input.allianceIds.map(Number))].filter((id) => own.ownAllianceIds.has(id))
  const link = input.isPublic ? false : input.link

  let salt: string | null = null
  if (link) {
    try {
      salt = tokenSalt()
    } catch {
      return { error: 'Share links are unavailable: TOKEN_SALT is not configured.' }
    }
  }

  const secret = link ? (input.rotateLink || !existing.secret ? mintShareSecret() : existing.secret) : null

  const { error } = await supabase
    .from('lens')
    .update({ shared: true, corporation_ids: corporationIds, alliance_ids: allianceIds, secret })
    .eq('id', lensId)
    .eq('user_id', userId)
  if (error) return { error: error.message }

  revalidatePath('/lens')
  revalidatePath(`/lens/${lensId}`)

  return {
    share: {
      corporationIds,
      allianceIds,
      hasLink: secret != null,
      shareParam: secret != null && salt != null ? `${lensId}.${signShare(lensId, secret, salt)}` : null,
      isPublic: secret == null && corporationIds.length === 0 && allianceIds.length === 0,
    },
  }
}

export const revokeLensShare = async (lensId: string): Promise<{ error?: string }> => {
  const supabase = await createClient()
  const userId = await flaggedUser(supabase)
  if (!userId) return { error: 'Not available' }

  // Back to the unshared state — NOT an empty audience, which would be public.
  const { error } = await supabase
    .from('lens')
    .update({ shared: false, corporation_ids: [], alliance_ids: [], secret: null })
    .eq('id', lensId)
    .eq('user_id', userId)
  if (error) return { error: error.message }

  revalidatePath('/lens')
  revalidatePath(`/lens/${lensId}`)
  return {}
}
