'use server'

import { revalidatePath } from 'next/cache'

import { createClient } from '@/utils/supabase/server'

// Hide or unhide one of the caller's industry jobs — the writer behind the
// per-row menu on /industry (docs/sharing-layer/16-industry-job-share.md,
// PR 1). A hidden job drops out of every co-tenant's read of the job tables;
// the owner still sees it.
//
// Cookie-session client, never the service role: RLS is the guard. The insert
// policy on industry_job_hidden proves the caller owns the job it names (its
// `exists` reads the job table under the owner's own policies), and pins a
// corp job's hidden_by to one of the caller's registrations in that
// corporation. The owner key comes from the row the page already holds.

export type JobOwner = { kind: 'character'; registrationId: string } | { kind: 'corporation'; corporationId: number }

export type SetJobHiddenResult = { ok: true } | { ok: false; error: string }

const JOB_ID = /^\d+$/

// The row a hide inserts. A corp job is stamped with one of the caller's own
// characters in the corporation; any will do, the column is audit only.
const hiddenRow = async (
  supabase: Awaited<ReturnType<typeof createClient>>,
  jobId: string,
  owner: JobOwner
): Promise<Record<string, unknown> | null> => {
  if (owner.kind === 'character') return { job_id: jobId, registration_id: owner.registrationId }
  const { data: member } = await supabase
    .from('registration')
    .select('id')
    .eq('corporation_id', owner.corporationId)
    .limit(1)
    .maybeSingle<{ id: string }>()
  return member ? { job_id: jobId, corporation_id: owner.corporationId, hidden_by: member.id } : null
}

export const setJobHidden = async (jobId: string, owner: JobOwner, hidden: boolean): Promise<SetJobHiddenResult> => {
  if (!JOB_ID.test(jobId)) return { ok: false, error: 'Not a job id.' }
  const supabase = await createClient()

  if (hidden) {
    const row = await hiddenRow(supabase, jobId, owner)
    if (!row) return { ok: false, error: 'You have no character in that corporation.' }
    const { error } = await supabase.from('industry_job_hidden').insert(row)
    // Already hidden (a second tab, or a corpmate got there first) is the
    // state the caller asked for.
    if (error && error.code !== '23505') {
      console.error(`[industry] hiding job ${jobId} failed: ${error.message}`)
      return { ok: false, error: 'Could not hide this job.' }
    }
  } else {
    // One row per job, whichever owner key it carries; the delete policy
    // removes it only when that key is the caller's.
    const { error } = await supabase.from('industry_job_hidden').delete().eq('job_id', jobId)
    if (error) {
      console.error(`[industry] unhiding job ${jobId} failed: ${error.message}`)
      return { ok: false, error: 'Could not make this job visible.' }
    }
  }

  revalidatePath('/industry')
  return { ok: true }
}
