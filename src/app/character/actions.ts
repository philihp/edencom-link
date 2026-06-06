'use server'

import { randomUUID } from 'node:crypto'

import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'

import { sso } from './sso'
import { getEnabledScopes } from './userScopes'

// The per-character ESI extracts a "Refresh ESI" run fans out, one queue message
// per character each. `daily` is account-wide (it resolves affiliations for every
// registration at once), so it's dispatched once with no character.
const PER_CHARACTER_JOBS = ['assets', 'hourly', 'structures', 'orders'] as const

export const register = async (formData: FormData) => {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user?.id) {
    redirect('/account/login')
  }

  // A brand new player (no characters yet and no saved grant preferences) is sent
  // to choose what to share before we send them on to EVE SSO.
  const { count } = await supabase.from('registration').select('id', { count: 'exact', head: true })
  const { data: settings } = await supabase.from('user_settings').select('user_id').eq('user_id', user.id).maybeSingle()
  if ((count ?? 0) === 0 && !settings) {
    redirect('/settings/grants?from=characters')
  }

  const scopes = await getEnabledScopes(supabase, user.id)
  redirect(sso.getRedirectUrl('state', scopes))
}

// Run every scheduled ESI extract on demand for just the signed-in player's
// characters, then send them to /characters/refresh to watch it. Each unit of work
// (a per-character job for one character, or the account-wide daily job) becomes a
// refresh_task row and a matching Vercel queue message; the consumer flips each
// row's status as it runs. RLS scopes the registration read to the caller, so we
// only refresh ids the user owns; the inserts/enqueues use the service role.
export const refreshEsi = async () => {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user?.id) {
    redirect('/account/login')
  }

  const { data: characters } = await supabase.from('registration').select('id, name')
  const chars = characters ?? []

  const batchId = randomUUID()
  const tasks = [
    ...PER_CHARACTER_JOBS.flatMap((job) =>
      chars.map((c) => ({
        batch_id: batchId,
        user_id: user.id,
        job,
        character_id: c.id,
        character_name: c.name,
      }))
    ),
    // Account-wide, no character.
    { batch_id: batchId, user_id: user.id, job: 'daily', character_id: null, character_name: null },
  ]

  // Imported lazily so loading the page (and `next build`) never pulls the service
  // client / queue setup into the page bundle.
  const { sudoSupabase } = await import('@/supabase.js')
  const { data: inserted, error } = await sudoSupabase
    .from('refresh_task')
    .insert(tasks)
    .select('id, job, character_id')
  if (error) {
    throw error
  }

  const { send } = await import('@vercel/queue')
  await Promise.all(
    (inserted ?? []).map((t) => send('jobs', { job: t.job, characterId: t.character_id ?? undefined, taskId: t.id }))
  )

  redirect(`/characters/refresh?batch=${batchId}`)
}
