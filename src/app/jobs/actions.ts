'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'

import { establishedUser } from '../account/lib/establishedUser'

import { isChancellor } from '../account/settings/chancellor/chancellor'
import { PER_CHARACTER_JOBS, dispatchJobForCharacters, dispatchSingleJob } from '../character/dispatchRefresh'
import { jobEntry } from './registry'

// Kick one cell of /jobs: one job for one character (or for one corporation,
// named by a representative character of ours in it), or an account-wide job
// when characterId is null. Called from the per-cell refresh buttons; the
// poller then tracks the refresh_task row it creates.
//
// The allow-list is the page's own registry rather than a second copy of
// dispatchRefresh's job lists: a job the page can't render is a job it can't
// kick, and `kickable` is where that decision already lives.
export const refreshCell = async (job: string, characterId: string | null) => {
  const supabase = await createClient()

  const user = await establishedUser(supabase)
  if (!user) {
    redirect('/account/login')
  }

  const entry = jobEntry(job)
  if (!entry || entry.kickable === 'never') throw new Error(`not an on-demand job: ${job}`)

  // Character- and corp-scoped jobs are dispatched against a registration of
  // the caller's (for a corp job, whichever of their characters in it the page
  // picked as representative); the shared jobs take none.
  const entityScoped = entry.section !== 'universe'
  if (entityScoped && characterId == null) throw new Error(`${job} needs a character`)
  if (!entityScoped && characterId != null) throw new Error(`${job} is account-wide`)
  // Defense in depth — the UI only renders this cell for Chancellors, but a
  // direct call must be blocked too.
  if (entry.kickable === 'chancellor' && !(await isChancellor(user.id))) throw new Error('not authorized')

  let character: { id: string; name: string | null } | null = null
  if (characterId != null) {
    // RLS scopes the read to the caller's own registrations, so a foreign id
    // matches nothing and can't be refreshed on someone else's behalf.
    const { data } = await supabase.from('registration').select('id, name').eq('id', characterId).maybeSingle()
    if (!data) throw new Error('unknown character')
    character = data
  }

  await dispatchSingleJob(user.id, job, character)
  revalidatePath('/jobs')
}

// Kick one job for every character the caller has registered — the "refresh
// all" button inside a Characters row's expansion, for when the answer to "why
// is this stale" is "all of them", and clicking four cells in turn is just
// clicking four cells in turn. One batch, so Recent activity groups it.
//
// Per-character jobs only: a corp job is dispatched per corporation (see
// dispatchJobForCharacters), and the shared jobs have a single cell already.
export const refreshAllCharacters = async (job: string) => {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user?.id) {
    redirect('/account/login')
  }

  const entry = jobEntry(job)
  if (!entry || entry.section !== 'character' || entry.kickable === 'never') {
    throw new Error(`not an on-demand per-character job: ${job}`)
  }
  if (!(PER_CHARACTER_JOBS as readonly string[]).includes(job)) {
    throw new Error(`no per-character dispatch for: ${job}`)
  }

  // RLS scopes this to the caller's own registrations, which is what makes the
  // service-role dispatch below safe.
  const { data: characters } = await supabase
    .from('registration')
    .select('id, name')
    .order('created_at', { ascending: true })
  if (!characters?.length) return

  await dispatchJobForCharacters(user.id, job, characters)
  revalidatePath('/jobs')
}
