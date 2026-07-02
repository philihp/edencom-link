import { randomInt } from 'node:crypto'

import { handleCallback } from '@/utils/queue'

export const runtime = 'nodejs'
// 60s is the max the current Vercel plan allows. Per-character fan-out keeps each
// invocation small enough to fit; the account-wide jobs are a single batch each and
// GitHub Actions remains the safety net if one ever exceeds this on large datasets.
export const maxDuration = 60

// One extract job per ESI endpoint, named after that endpoint. The per-character
// jobs accept { characterIds }; the account-wide ones (characterIds: false) do
// batch work over everything at once. Each entry imports lazily so loading the
// route (and `next build`) never runs the job modules' top-level supabase
// service-client setup, which needs env vars absent at build time.
const JOBS = {
  'character-assets': {
    characterIds: true,
    load: async () => (await import('@/jobs/characterAssets.js')).runCharacterAssets,
  },
  'character-orders': {
    characterIds: true,
    load: async () => (await import('@/jobs/characterOrders.js')).runCharacterOrders,
  },
  'character-wallet': {
    characterIds: true,
    load: async () => (await import('@/jobs/characterWallet.js')).runCharacterWallet,
  },
  'character-wallet-transactions': {
    characterIds: true,
    load: async () => (await import('@/jobs/characterWalletTransactions.js')).runCharacterWalletTransactions,
  },
  'character-industry-jobs': {
    characterIds: true,
    load: async () => (await import('@/jobs/characterIndustryJobs.js')).runCharacterIndustryJobs,
  },
  'corp-structures': {
    characterIds: true,
    load: async () => (await import('@/jobs/corpStructures.js')).runCorpStructures,
  },
  'corp-assets': {
    characterIds: true,
    load: async () => (await import('@/jobs/corpAssets.js')).runCorpAssets,
  },
  'corp-wallet-journal': {
    characterIds: true,
    load: async () => (await import('@/jobs/corpWalletJournal.js')).runCorpWalletJournal,
  },
  'corp-wallet-transactions': {
    characterIds: true,
    load: async () => (await import('@/jobs/corpWalletTransactions.js')).runCorpWalletTransactions,
  },
  'corp-industry-jobs': {
    characterIds: true,
    load: async () => (await import('@/jobs/corpIndustryJobs.js')).runCorpIndustryJobs,
  },
  'character-affiliations': {
    characterIds: false,
    load: async () => (await import('@/jobs/characterAffiliations.js')).runCharacterAffiliations,
  },
  'universe-names': {
    characterIds: false,
    load: async () => (await import('@/jobs/universeNames.js')).runUniverseNames,
  },
  'universe-structures': {
    characterIds: false,
    load: async () => (await import('@/jobs/universeStructures.js')).runUniverseStructures,
  },
  'industry-systems': {
    characterIds: false,
    load: async () => (await import('@/jobs/industrySystems.js')).runIndustrySystems,
  },
} satisfies Record<
  string,
  { characterIds: boolean; load: () => Promise<(opts?: { characterIds?: string[] }) => Promise<unknown>> }
>

type JobName = keyof typeof JOBS

// characterId is a registration uuid (per-character fan-out); absent runs the job
// for everyone. taskId, when present, is a refresh_task row the "Refresh ESI" flow
// tracks — the consumer flips it running -> done/error so /character/refresh can
// show live status.
type Msg = {
  job: JobName
  characterId?: string
  taskId?: string
}

// A thrown error fails the callback, so the Vercel queue retries the message
// (per retryAfterSeconds in vercel.json).
export const POST = handleCallback(async (message: Msg) => {
  const { job, characterId, taskId } = message
  console.log(`[queue/jobs] consume job=${job} characterId=${characterId ?? '-'} taskId=${taskId ?? '-'}`)

  const entry = JOBS[job]
  if (!entry) throw new Error(`unknown job: ${String(job)}`)

  const runJob = async () => {
    const run = await entry.load()
    if (entry.characterIds) {
      await run(characterId != null ? { characterIds: [characterId] } : undefined)
      return
    }
    // Account-wide jobs consume a single whole-job message, so the consumer records
    // their heartbeat (the per-character producers record their own at enqueue time).
    const { recordHeartbeat } = await import('@/supabase.js')
    const runId = randomInt(1, 2 ** 48)
    await recordHeartbeat(job, 'start', { runId, source: 'vercel' })
    try {
      await run()
    } finally {
      await recordHeartbeat(job, 'end', { runId, source: 'vercel' })
    }
  }

  // Not part of a tracked "Refresh ESI" run: just run it, letting a throw retry.
  if (taskId == null) {
    await runJob()
    return
  }

  // Tracked: record status on the refresh_task row. Best-effort — a failure is
  // recorded and swallowed rather than rethrown, so the queue doesn't retry it and
  // the page settles on a terminal state the user can see.
  const { sudoSupabase } = await import('@/supabase.js')
  await sudoSupabase
    .from('refresh_task')
    .update({ status: 'running', started_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', taskId)
  try {
    await runJob()
    await sudoSupabase
      .from('refresh_task')
      .update({ status: 'done', ended_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', taskId)
  } catch (e) {
    await sudoSupabase
      .from('refresh_task')
      .update({
        status: 'error',
        ended_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        error: String(e instanceof Error ? e.message : e).slice(0, 500),
      })
      .eq('id', taskId)
  }
})
