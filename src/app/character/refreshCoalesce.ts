// Which on-demand refreshes to actually start. Pure: the dispatcher hands it
// the tasks it wants, the account's recent tasks, and the clock, and gets
// back the ones worth a workflow run. Tested in test/refreshCoalesce.test.ts.
//
// On 2026-09-30 one account linked thirty characters in eighteen minutes and
// then pressed refresh; every add and every press dispatched the full set,
// so the daily corp jobs ran 1,159 times in an hour, the asset reconciles
// ran fifty deep and died on statement timeouts, and ESI began answering
// 429. Nothing here stops a user asking; it stops the same work being started
// twice while the first run is still worth waiting for.

// A task finished this recently answers the new request already.
export const RECENT_WINDOW_MS = 10 * 60_000
// A task still pending or running covers the new request — unless it is this
// old, in which case it is stuck rather than in flight and a new run is due.
export const IN_FLIGHT_MAX_AGE_MS = 60 * 60_000

// What a task is *for*: one character, one corporation, or the whole account.
// Two tasks with the same key do the same work, whichever character was
// picked to represent a corporation.
export type TaskTarget = {
  job: string
  registrationId: string | null
  // The corporation a corp-scoped job's representative belongs to; null when
  // not yet known (a brand-new registration), in which case the character
  // itself is the key and the corp jobs run for it.
  corporationId?: number | null
  corpScoped: boolean
}

export const taskKey = ({ job, registrationId, corporationId, corpScoped }: TaskTarget): string => {
  if (corpScoped && corporationId != null) return `${job}:corp:${corporationId}`
  if (registrationId != null) return `${job}:${registrationId}`
  return `${job}:account`
}

export type RecentTask = { key: string; status: string; createdAt: string }

// Whether a recent task still answers a request made now.
export const stillCovers = (recent: RecentTask, now: number): boolean => {
  const age = now - Date.parse(recent.createdAt)
  if (Number.isNaN(age)) return false
  const inFlight = recent.status === 'pending' || recent.status === 'running'
  return inFlight ? age < IN_FLIGHT_MAX_AGE_MS : age < RECENT_WINDOW_MS
}

// The tasks to start, and the ones a recent task already covers. A duplicate
// key inside the request itself is kept once.
export const coalesce = <T extends { key: string }>(
  tasks: T[],
  recent: RecentTask[],
  now: number
): { kept: T[]; skipped: T[] } => {
  const covered = new Set(recent.filter((r) => stillCovers(r, now)).map((r) => r.key))
  const seen = new Set<string>()
  return tasks.reduce<{ kept: T[]; skipped: T[] }>(
    (acc, task) => {
      const duplicate = covered.has(task.key) || seen.has(task.key)
      seen.add(task.key)
      return duplicate ? { ...acc, skipped: [...acc.skipped, task] } : { ...acc, kept: [...acc.kept, task] }
    },
    { kept: [], skipped: [] }
  )
}

export type Registration = { id: string; corporationId: number | null }

// Which characters of a batch stand for their corporation in the corp-scoped
// jobs: one per corporation, and only a corporation the batch *introduces* to
// the account. A character whose corporation already has a member on the
// account outside the batch adds nothing the corp's scheduled runs are not
// already tracking, so a single character add starts no corp job for it;
// "refresh everything" passes every character and so keeps every corp. A
// character with no known corporation yet is always kept — there is nothing
// to dedupe it against, and it is exactly the case the corp jobs must run for.
export const corpRepresentatives = <T extends Registration>(batch: T[], account: Registration[]): T[] => {
  const batchIds = new Set(batch.map((c) => c.id))
  const trackedElsewhere = new Set(
    account.flatMap((r) => (!batchIds.has(r.id) && r.corporationId != null ? [r.corporationId] : []))
  )
  const seen = new Set<number>()
  return batch.filter((c) => {
    if (c.corporationId == null) return true
    if (seen.has(c.corporationId) || trackedElsewhere.has(c.corporationId)) return false
    seen.add(c.corporationId)
    return true
  })
}
