import { randomInt } from 'node:crypto'

import { handleCallback } from '@/utils/queue'

export const runtime = 'nodejs'
// 60s is the max the current Vercel plan allows. Per-character fan-out keeps each
// invocation small enough to fit; the account-wide jobs are a single batch each. The
// whole-corp/whole-universe jobs (corp-structures, corp-blueprints, corp-wallet-journal,
// universe-structures) aren't fanned out at all — their /api/cron/* routes run them
// inline instead of going through this consumer, so a large account growing past this
// limit on one of those is a real risk to watch for via their heartbeat durations.

// One extract job per ESI endpoint, named after that endpoint. The per-character
// jobs accept { registrationIds }; the account-wide ones (registrationIds: false) do
// batch work over everything at once. Each entry imports lazily so loading the
// route (and `next build`) never runs the job modules' top-level supabase
// service-client setup, which needs env vars absent at build time.
const JOBS = {
  'character-assets': {
    registrationIds: true,
    load: async () => (await import('@/jobs/characterAssets.js')).runCharacterAssets,
  },
  'character-blueprints': {
    registrationIds: true,
    load: async () => (await import('@/jobs/characterBlueprints.js')).runCharacterBlueprints,
  },
  'character-orders': {
    registrationIds: true,
    load: async () => (await import('@/jobs/characterOrders.js')).runCharacterOrders,
  },
  'character-wallet': {
    registrationIds: true,
    load: async () => (await import('@/jobs/characterWallet.js')).runCharacterWallet,
  },
  'character-wallet-transactions': {
    registrationIds: true,
    load: async () => (await import('@/jobs/characterWalletTransactions.js')).runCharacterWalletTransactions,
  },
  'character-industry-jobs': {
    registrationIds: true,
    load: async () => (await import('@/jobs/characterIndustryJobs.js')).runCharacterIndustryJobs,
  },
  'character-mercenary-dens': {
    registrationIds: true,
    load: async () => (await import('@/jobs/characterMercenaryDens.js')).runCharacterMercenaryDens,
  },
  'character-fittings': {
    registrationIds: true,
    load: async () => (await import('@/jobs/characterFittings.js')).runCharacterFittings,
  },
  'character-location': {
    registrationIds: true,
    load: async () => (await import('@/jobs/characterLocation.js')).runCharacterLocation,
  },
  'character-clones': {
    registrationIds: true,
    load: async () => (await import('@/jobs/characterClones.js')).runCharacterClones,
  },
  'character-implants': {
    registrationIds: true,
    load: async () => (await import('@/jobs/characterImplants.js')).runCharacterImplants,
  },
  'character-ship': {
    registrationIds: true,
    load: async () => (await import('@/jobs/characterShip.js')).runCharacterShip,
  },
  'character-skills': {
    registrationIds: true,
    load: async () => (await import('@/jobs/characterSkills.js')).runCharacterSkills,
  },
  // Combined live-state job: runs character-wallet + character-location +
  // character-implants + character-clones + character-ship + character-skills per
  // character in one invocation. The individual entries above stay for
  // manual/backfill runs, but the cron and the /character/refresh UI dispatch
  // this one instead.
  'character-status': {
    registrationIds: true,
    load: async () => (await import('@/jobs/characterStatus.js')).runCharacterStatus,
  },
  'corp-structures': {
    registrationIds: true,
    load: async () => (await import('@/jobs/corpStructures.js')).runCorpStructures,
  },
  'corp-assets': {
    registrationIds: true,
    load: async () => (await import('@/jobs/corpAssets.js')).runCorpAssets,
  },
  'corp-blueprints': {
    registrationIds: true,
    load: async () => (await import('@/jobs/corpBlueprints.js')).runCorpBlueprints,
  },
  'corp-wallet-journal': {
    registrationIds: true,
    load: async () => (await import('@/jobs/corpWalletJournal.js')).runCorpWalletJournal,
  },
  'corp-wallet-transactions': {
    registrationIds: true,
    load: async () => (await import('@/jobs/corpWalletTransactions.js')).runCorpWalletTransactions,
  },
  'corp-industry-jobs': {
    registrationIds: true,
    load: async () => (await import('@/jobs/corpIndustryJobs.js')).runCorpIndustryJobs,
  },
  'character-directory': {
    registrationIds: false,
    load: async () => (await import('@/jobs/characterDirectory.js')).runCharacterDirectory,
  },
  'universe-names': {
    registrationIds: false,
    load: async () => (await import('@/jobs/universeNames.js')).runUniverseNames,
  },
  'universe-structures': {
    registrationIds: false,
    load: async () => (await import('@/jobs/universeStructures.js')).runUniverseStructures,
  },
  'industry-systems': {
    registrationIds: false,
    load: async () => (await import('@/jobs/industrySystems.js')).runIndustrySystems,
  },
} satisfies Record<
  string,
  { registrationIds: boolean; load: () => Promise<(opts?: { registrationIds?: string[] }) => Promise<unknown>> }
>

type JobName = keyof typeof JOBS

// characterId is a registration uuid (per-character fan-out); absent runs the job
// for everyone. registrationIds carries more than one — used for the corp-scoped jobs,
// where a single queue message covers every character known to carry the corp's
// scope, so forEachCorporation (src/jobs/lib.js) can fall back to the next one if an
// earlier character turns out to lack the in-game role the corp endpoint requires.
// taskId, when present, is a refresh_task row the "Refresh ESI" flow tracks — the
// consumer flips it running -> done/error so /character/refresh can show live status.
type Msg = {
  job: JobName
  characterId?: string
  registrationIds?: string[]
  // Transitional: messages enqueued before the registrationIds rename carry the
  // old key. Read for one deploy so a message already in the queue keeps its
  // scoping — dropping it silently would widen the message to every character
  // rather than error, and the job would just do more work than asked. Safe to
  // delete once the queue has drained past this release.
  characterIds?: string[]
  taskId?: string
}

// Emit this invocation's memory footprint as a `job.peak_rss` metric line
// (src/observability.js). Called from a `finally` so it fires on every exit
// path (success, throw, tracked, untracked) — the point is to see what the job
// actually needs so the function's `memory` limit (vercel.json) can be sized
// against real usage rather than guessed.
const logMemoryUsage = async (job: string) => {
  const { recordPeakRss } = await import('@/observability.js')
  recordPeakRss({ job })
}

// A thrown error fails the callback, so the Vercel queue retries the message
// (per retryAfterSeconds in vercel.json).
export const POST = handleCallback(async (message: Msg) => {
  const { job, characterId, registrationIds, characterIds, taskId } = message
  const ids = registrationIds ?? characterIds ?? (characterId != null ? [characterId] : undefined)
  console.log(`[queue/jobs] consume job=${job} registrationIds=${ids?.join(',') ?? '-'} taskId=${taskId ?? '-'}`)

  // Pilot: character-implants runs as a Vercel Workflow instead of inline, to
  // validate the queue → workflow chain before any other job migrates (see
  // src/workflows/characterImplants.ts). Fire-and-forget: the workflow owns
  // retries, and its run/step status shows under Observability → Workflows.
  // This job is never dispatched with a taskId (it's in no dispatchRefresh
  // list), so tracked refresh_task semantics don't apply here.
  if (job === 'character-implants') {
    const { start } = await import('workflow/api')
    const { characterImplantsWorkflow } = await import('@/workflows/characterImplants')
    const run = await start(characterImplantsWorkflow, [ids])
    console.log(`[queue/jobs] started workflow run=${run.runId} job=${job}`)
    return
  }

  try {
    const entry = JOBS[job]
    if (!entry) throw new Error(`unknown job: ${String(job)}`)

    const runJob = async () => {
      const run = await entry.load()
      if (entry.registrationIds) {
        await run(ids ? { registrationIds: ids } : undefined)
        return
      }
      // Account-wide jobs consume a single whole-job message, so the consumer records
      // their heartbeat here. Per-character/per-corp jobs record their own instead,
      // one row per character/corp attributed via registration_id/corporation_id/user_id
      // (see withHeartbeat in src/jobs/lib.js), regardless of whether this queue or a
      // GitHub Actions cron invoked them.
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
  } finally {
    await logMemoryUsage(job)
  }
})
