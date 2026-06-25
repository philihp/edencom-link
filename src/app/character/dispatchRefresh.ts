import { randomUUID } from 'node:crypto'

// The per-character ESI extracts a refresh fans out, one queue message per
// character each. `daily` is account-wide (it resolves affiliations for every
// registration at once), so it's dispatched once with no character.
//
// `structures` is deliberately NOT here: it does whole-corp/whole-universe work
// (notably pulling the full EVE industry cost index) that isn't scoped per
// character, so fanning it out made every message redo the same heavy pull and
// blow past the 60s queue function limit. It runs on its own daily GitHub Actions
// cron (structures.yml) instead.
const PER_CHARACTER_JOBS = ['assets', 'hourly', 'orders'] as const

type Character = { id: string; name: string | null }

// Run every scheduled ESI extract on demand for the given characters: insert a
// refresh_task row per unit of work (a per-character job for one character, or the
// account-wide daily job) and enqueue a matching Vercel queue message tagged with
// that row's id, which the consumer flips running -> done/error. Returns the batch
// id so callers can link to /characters/refresh?batch=<id>. Uses the service role,
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
    { batch_id: batchId, user_id: userId, job: 'daily', character_id: null, character_name: null },
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
  console.log(`[dispatchRefresh] enqueued ${sent.length} jobs to topic "jobs" region=${process.env.QUEUE_REGION ?? 'sfo1'}`)

  return batchId
}
