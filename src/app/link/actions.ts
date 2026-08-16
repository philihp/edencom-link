'use server'

import { graphql } from 'graphql'
import { revalidatePath } from 'next/cache'

import { contextForUser } from '@/app/api/graphql/context'
import { schema } from '@/app/api/graphql/schema'
import type { SaveShareInput, SaveShareResult } from '@/app/asset/shareActions'
import { LINK_FLAG, hasFlag } from '@/flags'
import { createClient } from '@/utils/supabase/server'
import { resolveLink } from './access'
import { applyLinkShare, fetchOwnAudiences } from './share'
import { parseLinkVariables, validateLinkQuery } from './validate'

// Server actions behind the /link editor (docs/sharing-layer/07-link.md).
// Cookie-session client throughout, like every share writer: RLS pins link
// rows to their owner. Everything here is additionally gated on the caller's
// own link flag — the editor is dark-launched.

// Every action here refuses the same way when the caller has no Link
// clearance: the account exists, the capability is not issued to it. Stated
// plainly first — a model or a person reading this needs to know who to ask.
const NOT_CLEARED = 'Link clearance is not held on this account. Ask the site owner to issue it.'

const flaggedUser = async (supabase: Awaited<ReturnType<typeof createClient>>): Promise<string | null> => {
  const { data: auth, error } = await supabase.auth.getUser()
  if (error || !auth?.user) return null
  return (await hasFlag(auth.user.id, LINK_FLAG)) ? auth.user.id : null
}

export type SaveLinkInput = { name: string; query: string; variables: string }
export type SaveLinkResult = { error?: string; id?: string }

export const saveLink = async (linkId: string | null, input: SaveLinkInput): Promise<SaveLinkResult> => {
  const supabase = await createClient()
  const userId = await flaggedUser(supabase)
  if (!userId) return { error: NOT_CLEARED }

  const name = input.name.trim()
  if (name === '') return { error: 'Give the Link a name.' }

  const validation = validateLinkQuery(input.query)
  if (!validation.ok) return { error: validation.message }
  const variables = parseLinkVariables(input.variables)
  if (!variables.ok) return { error: variables.message }

  // RLS pins both branches to the caller: with check on insert, using on the
  // update's row match (a foreign id simply updates nothing).
  const row = { name, query: input.query, variables: variables.variables, updated_at: new Date().toISOString() }
  const { data: saved, error } = linkId
    ? await supabase.from('link').update(row).eq('id', linkId).eq('user_id', userId).select('id').maybeSingle()
    : await supabase
        .from('link')
        .insert({ ...row, user_id: userId })
        .select('id')
        .maybeSingle()
  if (error || !saved) return { error: error?.message ?? 'Save failed' }

  revalidatePath('/link')
  revalidatePath(`/link/${saved.id}`)
  return { id: saved.id as string }
}

export const deleteLink = async (linkId: string): Promise<{ error?: string }> => {
  const supabase = await createClient()
  const userId = await flaggedUser(supabase)
  if (!userId) return { error: NOT_CLEARED }

  const { error } = await supabase.from('link').delete().eq('id', linkId).eq('user_id', userId)
  if (error) return { error: error.message }
  revalidatePath('/link')
  return {}
}

// Run-as-me preview for the editor: validates, then executes under the
// CALLER's own context — the same result the audience will see, since the
// caller is the creator. Doesn't require the graphql flag: the link flag is
// the editor's gate. Structured rather than pre-stringified so the editor can
// render the same table the viewer page does (linkTable.tsx).
export const previewLink = async (input: {
  query: string
  variables: string
}): Promise<{ error?: string; data?: unknown; errors?: string[] }> => {
  const supabase = await createClient()
  const userId = await flaggedUser(supabase)
  if (!userId) return { error: NOT_CLEARED }

  const validation = validateLinkQuery(input.query)
  if (!validation.ok) return { error: validation.message }
  const variables = parseLinkVariables(input.variables)
  if (!variables.ok) return { error: variables.message }

  const contextValue = await contextForUser(userId)
  const result = await graphql({ schema, source: input.query, variableValues: variables.variables, contextValue })
  return { data: result.data ?? null, errors: (result.errors ?? []).map((e) => e.message) }
}

// Fork a link someone shared with you into your own list: same query and
// variables, your name on the row, unshared until you share it. Authorization
// is exactly the viewer's (resolveLink's RLS or signed-link door) — if you can
// see a link run, you can keep its QUERY, which was always visible on its
// page. The insert carries no audience: a copy never inherits the original's
// sharing.
export const copyLink = async (linkId: string, share?: string): Promise<{ error?: string; id?: string }> => {
  const supabase = await createClient()
  const userId = await flaggedUser(supabase)
  if (!userId) return { error: NOT_CLEARED }

  const resolved = await resolveLink(linkId, share)
  if (!resolved) return { error: 'Not found' }

  // RLS's with check pins the insert to the caller.
  const { data: saved, error } = await supabase
    .from('link')
    .insert({
      user_id: userId,
      name: `Copy of ${resolved.link.name}`,
      query: resolved.link.query,
      variables: resolved.link.variables ?? {},
    })
    .select('id')
    .maybeSingle()
  if (error || !saved) return { error: error?.message ?? 'Copy failed' }

  revalidatePath('/link')
  return { id: saved.id as string }
}

// The audience side, driven by the shared ShareDialog. The link row IS the
// share row, so save/revoke toggle its `enabled` flag and audience columns
// rather than upserting a sibling row. Requested audience ids are filtered to
// ones the caller actually has (the setSharedAlliances defense) — the dialog
// only offers those, but a form post is not a promise.
//
// The write itself lives in ./share.ts, shared with the MCP create_link tool
// so the two can't disagree about what "public" or "not shared" mean.
export const saveLinkShare = async (linkId: string, input: SaveShareInput): Promise<SaveShareResult> => {
  const supabase = await createClient()
  const userId = await flaggedUser(supabase)
  if (!userId) return { error: NOT_CLEARED }

  const { data: existing } = await supabase
    .from('link')
    .select('id, secret')
    .eq('id', linkId)
    .eq('user_id', userId)
    .maybeSingle<{ id: string; secret: string | null }>()
  if (!existing) return { error: 'Not your Link.' }

  const own = await fetchOwnAudiences(supabase)
  const ownCorpIds = new Set(own.corporations.map((c) => c.id))
  const ownAllianceIds = new Set(own.alliances.map((a) => a.id))

  const applied = await applyLinkShare(
    supabase,
    userId,
    linkId,
    {
      corporationIds: input.isPublic
        ? []
        : [...new Set(input.corporationIds.map(Number))].filter((id) => ownCorpIds.has(id)),
      allianceIds: input.isPublic
        ? []
        : [...new Set(input.allianceIds.map(Number))].filter((id) => ownAllianceIds.has(id)),
      link: input.isPublic ? false : input.link,
      isPublic: input.isPublic,
      // The dialog's Save always means "shared"; unsharing is Revoke's job, so
      // an empty audience here is the public reading, as it always was.
      shared: true,
    },
    { existingSecret: existing.secret, rotateLink: input.rotateLink }
  )
  if (!applied.ok) return { error: applied.message }

  revalidatePath('/link')
  revalidatePath(`/link/${linkId}`)
  return { share: applied.share ?? undefined }
}

export const revokeLinkShare = async (linkId: string): Promise<{ error?: string }> => {
  const supabase = await createClient()
  const userId = await flaggedUser(supabase)
  if (!userId) return { error: NOT_CLEARED }

  // Back to the unshared state — NOT an empty audience, which would be public.
  const applied = await applyLinkShare(
    supabase,
    userId,
    linkId,
    { corporationIds: [], allianceIds: [], link: false, isPublic: false, shared: false },
    { existingSecret: null }
  )
  if (!applied.ok) return { error: applied.message }

  revalidatePath('/link')
  revalidatePath(`/link/${linkId}`)
  return {}
}
