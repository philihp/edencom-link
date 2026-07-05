import { randomUUID } from 'node:crypto'

import { forEach, reduce } from 'ramda'

// The per-character ESI extracts a refresh fans out, one queue message per
// character each. Each job is named after the ESI endpoint it extracts.
const PER_CHARACTER_JOBS = [
  'character-assets',
  'character-blueprints',
  'character-orders',
  'character-wallet',
  'character-wallet-transactions',
  'character-industry-jobs',
] as const

// Corp-scoped jobs pull one corp's whole asset/job/transaction set. Fanning one
// message per character (like PER_CHARACTER_JOBS) risks two of the user's
// characters in the same corp racing a concurrent reconcile for it — the
// losing invocation's INSERT collides with the winner's already-committed row
// (`duplicate key value violates unique constraint ..._current_item_idx`),
// which can abort partway through with rows closed but never reopened, so real
// items vanish until a later, non-racing run reinserts them (see
// fanOutPerCorporationCronJob in src/utils/cron.ts, which has the same fix for
// the cron-triggered path). Dedupe to the user's first scoped character per
// corporation before dispatching.
//
// corp-assets and corp-industry-jobs are included so a newly added character's
// corp data shows up immediately rather than waiting for the next cron. The
// remaining daily corp jobs (corp-structures, corp-blueprints,
// corp-wallet-journal) are deliberately NOT here: they do whole-corp work that
// a per-character fan-out would just redo once per character, and running
// them on every character add isn't worth the extra load. They run on their
// own Vercel Cron schedule instead (see src/app/api/cron/corp-structures,
// corp-blueprints, corp-wallet-journal).
const PER_CORPORATION_JOBS = ['corp-wallet-transactions', 'corp-assets', 'corp-industry-jobs'] as const

// Account-wide batch jobs (they process every registration at once), dispatched
// once per refresh with no character.
const ACCOUNT_JOBS = ['character-affiliations', 'universe-names'] as const

type Character = { id: string; name: string | null }

// Drop any character whose corporation is already represented by an earlier
// character in the list. A character with no known corporation yet (a
// brand-new registration whose corp hasn't been resolved) is always kept —
// there's nothing to dedupe it against, and it's exactly the case
// corp-assets/corp-industry-jobs need to run for right away.
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
// row's id, which the consumer flips running -> done/error. Returns the batch id
// so callers can link to /character/refresh?batch=<id>. Uses the service role,
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
    ...PER_CORPORATION_JOBS.flatMap((job) =>
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

  const { send } = await import('@/utils/queue')
  const sent = await Promise.all(
    (inserted ?? []).map((t) => send('jobs', { job: t.job, characterId: t.character_id ?? undefined, taskId: t.id }))
  )
  console.log(
    `[dispatchRefresh] enqueued ${sent.length} jobs to topic "jobs" region=${process.env.QUEUE_REGION ?? 'sfo1'}`
  )

  return batchId
}
