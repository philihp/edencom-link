import { randomUUID } from 'node:crypto'

// The per-character ESI extracts a refresh fans out, one queue message per
// character each. Each job is named after the ESI endpoint it extracts.
//
// The daily corp jobs (corp-structures, corp-assets, corp-wallet-journal,
// corp-industry-jobs) are deliberately NOT here: they do whole-corp work that a
// per-character fan-out would just redo once per character, and the heavier ones
// blow past the 60s queue function limit. They run on their own GitHub Actions
// crons instead.
const PER_CHARACTER_JOBS = [
  'character-assets',
  'character-orders',
  'character-wallet',
  'character-wallet-transactions',
  'character-industry-jobs',
  'corp-wallet-transactions',
] as const

// Account-wide batch jobs (they process every registration at once), dispatched
// once per refresh with no character.
const ACCOUNT_JOBS = ['character-affiliations', 'universe-names'] as const

type Character = { id: string; name: string | null }

// Run every on-demand ESI extract for the given characters: insert a
// refresh_task row per unit of work (a per-character job for one character, or an
// account-wide job) and enqueue a matching Vercel queue message tagged with that
// row's id, which the consumer flips running -> done/error. Returns the batch id
// so callers can link to /character/refresh?batch=<id>. Uses the service role,
// so callers must pass a userId they've already authorized.
export const dispatchRefresh = async (userId: string, characters: Character[]): Promise<string> => {
  const batchId = randomUUID()
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
    ...ACCOUNT_JOBS.map((job) => ({
      batch_id: batchId,
      user_id: userId,
      job,
      character_id: null,
      character_name: null,
    })),
  ]

  // Imported lazily so importing this module never pulls the service client / queue
  // setup into a page bundle or `next build`.
  const { sudoSupabase } = await import('@/supabase.js')
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
