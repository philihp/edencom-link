import { randomUUID } from 'node:crypto'

import { forEach, reduce } from 'ramda'

// The per-character ESI extracts a refresh fans out, one queue message per
// character each. Most are named after the ESI endpoint they extract;
// character-status is the combined live-state job that pulls wallet, location,
// implants, and clones in one invocation (see src/jobs/characterStatus.js).
export const PER_CHARACTER_JOBS = [
  'character-assets',
  'character-blueprints',
  'character-orders',
  'character-wallet-transactions',
  'character-industry-jobs',
  'character-mercenary-dens',
  'character-status',
] as const

// Corp-scoped jobs pull one corp's whole asset/job/transaction set. Fanning one
// message per character (like PER_CHARACTER_JOBS) risks two of the user's
// characters in the same corp racing a concurrent reconcile for it — the
// losing invocation's INSERT collides with the winner's already-committed row
// (`duplicate key value violates unique constraint ..._current_item_idx`),
// which can abort partway through with rows closed but never reopened, so real
// items vanish until a later, non-racing run reinserts them. So, like the
// cron-triggered fan-out (fanOutPerCorporationCronJob in src/utils/cron.ts),
// each of these queues exactly one message per corporation — see
// dispatchRefresh below, which looks up every character (account-wide, not
// just this batch) known to carry the job's scope for that corp and sends the
// whole group, so forEachCorporation (src/jobs/lib.js) can fall back through
// them if the one representative character chosen for the refresh_task/UI row
// turns out to lack the in-game role — director, accountant, etc — the
// endpoint separately requires.
//
// corp-assets and corp-industry-jobs are included so a newly added character's
// corp data shows up immediately rather than waiting for the next cron. The
// remaining daily corp jobs (corp-structures, corp-blueprints,
// corp-wallet-journal) are deliberately NOT here: they do whole-corp work that
// a per-character fan-out would just redo once per character, and running
// them on every character add isn't worth the extra load. They run on their
// own Vercel Cron schedule instead (see src/app/api/cron/corp-structures,
// corp-blueprints, corp-wallet-journal).
const PER_CORPORATION_JOBS = [
  { job: 'corp-wallet-transactions', loadScope: async () => (await import('@/jobs/corpWalletTransactions.js')).SCOPE },
  { job: 'corp-assets', loadScope: async () => (await import('@/jobs/corpAssets.js')).SCOPE },
  { job: 'corp-industry-jobs', loadScope: async () => (await import('@/jobs/corpIndustryJobs.js')).SCOPE },
] as const

export const PER_CORPORATION_JOB_NAMES = PER_CORPORATION_JOBS.map(({ job }) => job)

// Account-wide batch jobs (they process every registration at once), dispatched
// once per refresh with no character.
export const ACCOUNT_JOBS = ['character-directory', 'universe-names'] as const

type Character = { id: string; name: string | null }

// Drop any character whose corporation is already represented by an earlier
// character in the list. A character with no known corporation yet (a
// brand-new registration whose corp hasn't been resolved) is always kept —
// there's nothing to dedupe it against, and it's exactly the case
// corp-assets/corp-industry-jobs need to run for right away. This only picks
// the representative character for the refresh_task/UI row — the actual queue
// message sent for that task carries every scoped character for the corp, not
// just this one (see dispatchRefresh below).
const oneCharacterPerCorporation = (characters: Character[], corporationById: Map<string, number | null>) => {
  const seenCorps = new Set<number>()
  return reduce(
    (kept: Character[], c) => {
      const corporationId = corporationById.get(c.id)
      if (corporationId != null) {
        if (seenCorps.has(corporationId)) return kept
        seenCorps.add(corporationId)
      }
      return [...kept, c]
    },
    [] as Character[],
    characters
  )
}

// Run every on-demand ESI extract for the given characters: insert a
// refresh_task row per unit of work (a per-character job for one character, or an
// account-wide job) and enqueue a matching Vercel queue message tagged with that
// row's id, which the consumer flips running -> done/error, live on
// /character/refresh. Used when a character is added; the per-cell refresh
// buttons go through dispatchSingleJob below instead. Uses the service role,
// so callers must pass a userId they've already authorized.
export const dispatchRefresh = async (userId: string, characters: Character[]): Promise<string> => {
  const batchId = randomUUID()

  // Imported lazily so importing this module never pulls the service client / queue
  // setup into a page bundle or `next build`.
  const { sudoSupabase } = await import('@/supabase.js')

  const corporationById = new Map<string, number | null>()
  if (characters.length > 0) {
    const { data: registrations, error: registrationsError } = await sudoSupabase
      .from('registration')
      .select('id, corporation_id')
      .in(
        'id',
        characters.map((c) => c.id)
      )
    if (registrationsError) throw registrationsError
    forEach((r) => corporationById.set(r.id, r.corporation_id), registrations ?? [])
  }
  const corpScopedCharacters = oneCharacterPerCorporation(characters, corporationById)

  // For each corp-scoped job, group every account-wide character carrying its
  // scope by corporation, so the message sent for a corp's task isn't limited
  // to just the one representative character chosen above.
  const { groupCharacterIdsByCorporation } = await import('@/supabase.js')
  const corpGroupsByJob = new Map<string, Map<number, string[]>>()
  await Promise.all(
    PER_CORPORATION_JOBS.map(async ({ job, loadScope }) => {
      const scope = await loadScope()
      const { byCorp } = await groupCharacterIdsByCorporation([scope])
      corpGroupsByJob.set(job, byCorp)
    })
  )

  const tasks = [
    ...PER_CHARACTER_JOBS.flatMap((job) =>
      characters.map((c) => ({
        batch_id: batchId,
        user_id: userId,
        job,
        character_id: c.id,
        character_name: c.name,
      }))
    ),
    ...PER_CORPORATION_JOBS.flatMap(({ job }) =>
      corpScopedCharacters.map((c) => ({
        batch_id: batchId,
        user_id: userId,
        job,
        character_id: c.id,
        character_name: c.name,
      }))
    ),
    ...ACCOUNT_JOBS.map((job) => ({
      batch_id: batchId,
      user_id: userId,
      job,
      character_id: null,
      character_name: null,
    })),
  ]

  const { data: inserted, error } = await sudoSupabase
    .from('refresh_task')
    .insert(tasks)
    .select('id, job, character_id')
  if (error) {
    throw error
  }

  // A corp-scoped task's message carries every scoped character for its
  // corporation (see corpGroupsByJob above); every other task's message
  // carries just its own single character (or none, for the account-wide jobs).
  const characterIdsForTask = (t: { job: string; character_id: string | null }): string[] | undefined => {
    if (t.character_id == null) return undefined
    const byCorp = corpGroupsByJob.get(t.job)
    if (!byCorp) return [t.character_id]
    const corporationId = corporationById.get(t.character_id)
    if (corporationId == null) return [t.character_id]
    return byCorp.get(corporationId) ?? [t.character_id]
  }

  const { send } = await import('@/utils/queue')
  const sent = await Promise.all(
    (inserted ?? []).map((t) => send('jobs', { job: t.job, characterIds: characterIdsForTask(t), taskId: t.id }))
  )
  console.log(
    `[dispatchRefresh] enqueued ${sent.length} jobs to topic "jobs" region=${process.env.QUEUE_REGION ?? 'sfo1'}`
  )

  return batchId
}

// One cell of the /character/refresh matrix: insert a single refresh_task row
// and enqueue its one queue message. `character` is null for the account-wide
// jobs. For a corp-scoped job the message carries every scoped character in the
// representative character's corporation — the same grouping dispatchRefresh
// sends — so forEachCorporation can fall back through them if the
// representative lacks the in-game role the corp endpoint requires.
export const dispatchSingleJob = async (userId: string, job: string, character: Character | null): Promise<void> => {
  // Imported lazily for the same build-time reason as dispatchRefresh above.
  const { sudoSupabase, groupCharacterIdsByCorporation } = await import('@/supabase.js')

  const characterIdsForMessage = async (): Promise<string[] | undefined> => {
    if (!character) return undefined
    const corpJob = PER_CORPORATION_JOBS.find((j) => j.job === job)
    if (!corpJob) return [character.id]
    const { data: registration, error } = await sudoSupabase
      .from('registration')
      .select('corporation_id')
      .eq('id', character.id)
      .maybeSingle()
    if (error) throw error
    const corporationId = registration?.corporation_id
    if (corporationId == null) return [character.id]
    const scope = await corpJob.loadScope()
    const { byCorp } = await groupCharacterIdsByCorporation([scope])
    return byCorp.get(corporationId) ?? [character.id]
  }
  const characterIds = await characterIdsForMessage()

  const { data: inserted, error } = await sudoSupabase
    .from('refresh_task')
    .insert({
      batch_id: randomUUID(),
      user_id: userId,
      job,
      character_id: character?.id ?? null,
      character_name: character?.name ?? null,
    })
    .select('id')
    .single()
  if (error) throw error

  const { send } = await import('@/utils/queue')
  await send('jobs', { job, characterIds, taskId: inserted.id })
  console.log(`[dispatchSingleJob] enqueued ${job} for ${character?.name ?? 'account'} taskId=${inserted.id}`)
}
