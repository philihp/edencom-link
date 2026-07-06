'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'

import { ACCOUNT_JOBS, PER_CHARACTER_JOBS, PER_CORPORATION_JOB_NAMES, dispatchSingleJob } from '../dispatchRefresh'

// Kick one cell of the refresh matrix: one job for one character (or one
// account-wide job when characterId is null). Called from the per-cell
// refresh buttons; the poller then tracks the refresh_task row it creates.
export const refreshCell = async (job: string, characterId: string | null) => {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user?.id) {
    redirect('/account/login')
  }

  const characterScoped = ([...PER_CHARACTER_JOBS, ...PER_CORPORATION_JOB_NAMES] as readonly string[]).includes(job)
  const accountScoped = (ACCOUNT_JOBS as readonly string[]).includes(job)
  if (!characterScoped && !accountScoped) throw new Error(`not an on-demand job: ${job}`)
  if (characterScoped && characterId == null) throw new Error(`${job} needs a character`)
  if (accountScoped && characterId != null) throw new Error(`${job} is account-wide`)

  let character: { id: string; name: string | null } | null = null
  if (characterId != null) {
    // RLS scopes the read to the caller's own registrations, so a foreign id
    // matches nothing and can't be refreshed on someone else's behalf.
    const { data } = await supabase.from('registration').select('id, name').eq('id', characterId).maybeSingle()
    if (!data) throw new Error('unknown character')
    character = data
  }

  await dispatchSingleJob(user.id, job, character)
  revalidatePath('/character/refresh')
}
