'use server'

// The /registration matrix's own dispatch levers, completing the design's four
// refresh granularities (docs/registrations-page/00a-design-extraction.md §1,
// "the axes rule"): the row-tail ↻ (every job for one character) and the page
// header's ↻ (everything). The other two axes reuse /jobs's actions directly —
// refreshCell for one cell, refreshAllCharacters for a column sweep — so there
// is exactly one dispatch path per shape.
//
// Both go through dispatchRefresh, the same fan-out adding a character runs:
// every on-demand per-character job, the corp jobs for the characters' corps,
// and the account-wide jobs, one batch so Recent activity groups it.
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'

import { establishedUser } from '../lib/establishedUser'
import { dispatchRefresh } from '../../character/dispatchRefresh'
import { defaultScopes, optionalScopes, requiredScopes } from '../../character/scopes'

// Kick every on-demand job for one character of the caller's.
export const refreshCharacter = async (characterId: string) => {
  const supabase = await createClient()

  const user = await establishedUser(supabase)
  if (!user) {
    redirect('/account/login')
  }

  // RLS scopes the read to the caller's own registrations, so a foreign id
  // matches nothing and can't be refreshed on someone else's behalf.
  const { data: character } = await supabase.from('registration').select('id, name').eq('id', characterId).maybeSingle()
  if (!character) throw new Error('unknown character')

  await dispatchRefresh(user.id, [character])
  revalidatePath('/account/registrations')
}

// Kick every on-demand job for every character — the header's "refresh all".
export const refreshEverything = async () => {
  const supabase = await createClient()

  const user = await establishedUser(supabase)
  if (!user) {
    redirect('/account/login')
  }

  const { data: characters } = await supabase
    .from('registration')
    .select('id, name')
    .order('created_at', { ascending: true })
  if (!characters?.length) return

  await dispatchRefresh(user.id, characters)
  revalidatePath('/account/registrations')
}

// Toggle a set of optional scopes in the account's request template — the
// matrix's template-row checkboxes. One checkbox governs one job column, which
// for character-status is six scopes at once; a mixed column completes to the
// full set first (matrix.ts templateCheck), so this takes the target state
// rather than flipping each scope independently.
//
// Same storage as /settings/grants (user_settings.enabled_scopes, required
// scopes always kept), without that page's redirect — the caller stays on the
// matrix and the row re-renders.
export const setTemplateScopes = async (scopes: string[], on: boolean) => {
  const supabase = await createClient()

  const user = await establishedUser(supabase)
  if (!user) {
    redirect('/account/login')
  }

  // Only real optional scopes can be toggled; anything else in the payload
  // (a required scope, a typo, a scope we never ask for) is dropped.
  const toggled = scopes.filter((scope) => optionalScopes.includes(scope))
  if (toggled.length === 0) return

  const { data: settings } = await supabase
    .from('user_settings')
    .select('enabled_scopes')
    .eq('user_id', user.id)
    .maybeSingle()
  // No saved row means the default template (every non-opt-in scope) — see
  // userScopes.ts. Materialize that before editing, or the first toggle-off
  // would save a template of nothing but the toggled scopes.
  const current: string[] = settings?.enabled_scopes ?? defaultScopes
  const kept = current.filter((scope) => !toggled.includes(scope))
  const enabled_scopes = [...new Set([...requiredScopes, ...kept, ...(on ? toggled : [])])]

  const { error } = await supabase
    .from('user_settings')
    .upsert({ user_id: user.id, enabled_scopes, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
  if (error) throw new Error(error.message)

  revalidatePath('/account/registrations')
}
