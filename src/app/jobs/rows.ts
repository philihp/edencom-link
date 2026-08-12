// The pure reductions behind /jobs (docs/jobs-page.md): how a set of per-entity
// heartbeats, open runs and refresh_task rows collapse into the one row per job
// the page renders. No I/O and no React, so the arithmetic that decides "is my
// data stale" and "is this job running" is testable on its own (test/jobsRows.test.ts).

import { freshnessLevel } from '../freshness.ts'

// 'skipped' is a run that was allowed to do nothing: a corp endpoint the
// character holds no in-game role for. Not a failure and not a pull — see
// forEachCorporation (src/jobs/lib.js) and heartbeat.skipped_reason.
export type EntityStatus = 'running' | 'queued' | 'failed' | 'skipped' | 'idle'

// One owner of a job's data — a registered character, a corporation, or (for
// the shared jobs) the single implicit account-wide owner.
export type EntityRun = {
  // registration uuid, corporation id as a string, or '' account-wide.
  id: string
  name: string | null
  lastRunAt: string | null
  status: EntityStatus
  // The failure's message, from whichever of the two sources set the status to
  // 'failed' — a refresh_task the caller kicked, or the job's own end heartbeat.
  // For 'skipped' it's the reason the run was a permitted no-op instead.
  error: string | null
  // Corp rows only: whose token the last pull ran under. runsAsCorpmate means a
  // director on another account in the same corp, visible as a corp-scoped
  // heartbeat but not as a registration we can name.
  runsAs?: string | null
  runsAsCorpmate?: boolean
}

// An entity we're not permitted to pull has no freshness to speak of: a corp
// nobody on this account directs would otherwise pin its job's row at "never"
// forever, which reads as broken data rather than as data that was never ours.
const pullable = (entities: readonly EntityRun[]): EntityRun[] =>
  entities.filter((entity) => entity.status !== 'skipped')

// The row's headline freshness is the OLDEST of the caller's entities, not the
// newest: the question is "is my data fresh", and one character that hasn't
// pulled since yesterday is the answer even when the other three ran minutes
// ago. A never-run entity is older than any timestamp.
export const oldestRun = (all: readonly EntityRun[]): string | null => {
  const entities = pullable(all)
  if (entities.length === 0) return null
  if (entities.some((entity) => entity.lastRunAt === null)) return null
  return entities.reduce<string | null>(
    (oldest, entity) => (oldest === null || (entity.lastRunAt as string) < oldest ? entity.lastRunAt : oldest),
    null
  )
}

// The newest run across the caller's entities — the opposite end from
// oldestRun, and the right input to the overdue check: "did this job fire at
// all" is a different question from "is every one of my characters current".
// One lagging character must not make the *schedule* look broken.
export const newestRun = (entities: readonly EntityRun[]): string | null =>
  entities.reduce<string | null>(
    (newest, entity) =>
      entity.lastRunAt !== null && (newest === null || entity.lastRunAt > newest) ? entity.lastRunAt : newest,
    null
  )

const LEVEL_RANK: Record<string, number> = { fresh: 0, aging: 1, stale: 2, none: 3 }

// How many entities are behind the best-off one. "0 of 4 fresh" would be the
// normal state for a six-hourly job and teaches nothing; what's worth a note is
// one character lagging the others, which is a real symptom (dead token, missing
// scope) rather than the cadence doing its job.
export const laggingCount = (all: readonly EntityRun[], now: number = Date.now()): number => {
  // Skipped entities are excluded for the same reason as in oldestRun: never
  // being allowed to pull isn't lagging behind.
  const entities = pullable(all)
  if (entities.length === 0) return 0
  const ranks = entities.map((entity) => LEVEL_RANK[freshnessLevel(entity.lastRunAt, now)])
  const best = Math.min(...ranks)
  return ranks.filter((rank) => rank > best).length
}

// First match wins, mirroring the status table in the plan: anything in flight
// beats anything queued beats a failure, and the freshness dot carries the rest.
export const rowStatus = (entities: readonly EntityRun[]): EntityStatus => {
  if (entities.some((e) => e.status === 'running')) return 'running'
  if (entities.some((e) => e.status === 'queued')) return 'queued'
  if (entities.some((e) => e.status === 'failed')) return 'failed'
  // Only when *every* entity is a no-op: one corp we can't pull shouldn't
  // relabel a job that ran fine for the other one.
  if (entities.length > 0 && entities.every((e) => e.status === 'skipped')) return 'skipped'
  return 'idle'
}

export type StatusInputs = {
  // The caller's most recent refresh_task for this job + entity, if recent.
  task?: { status: string; error: string | null }
  // Is there an open heartbeat (started, not ended, recent) for this cell? This
  // is what makes a *scheduled* run visible as running — latest_heartbeats()
  // only ever returns completed rows.
  open?: boolean
  // The newest completed heartbeat's outcome. ok === false is a run that threw;
  // null means "unknown" (rows predating the column, CLI runs). skippedReason
  // set (with ok true) is a run that was permitted to do nothing.
  beat?: { ok: boolean | null; error: string | null; skippedReason?: string | null }
}

export const statusOf = ({ task, open, beat }: StatusInputs): { status: EntityStatus; error: string | null } => {
  if (task?.status === 'running' || open) return { status: 'running', error: null }
  if (task?.status === 'pending') return { status: 'queued', error: null }
  if (task?.status === 'error') return { status: 'failed', error: task.error }
  // A scheduled run that failed is a failure too, and it's the only way a dead
  // token on one character is distinguishable from a job that simply runs daily.
  if (beat?.ok === false) return { status: 'failed', error: beat.error }
  // A no-op the character was never permitted to perform. Below 'failed' on
  // purpose: if the last run actually threw, that's the more urgent fact.
  if (beat?.skippedReason != null) return { status: 'skipped', error: beat.skippedReason }
  return { status: 'idle', error: null }
}

export type ActivityTask = {
  id: string
  batch_id: string
  job: string
  character_name: string | null
  status: string
  error: string | null
  created_at: string
  started_at: string | null
  ended_at: string | null
}

export type ActivityRow = ActivityTask & {
  // A batch is one dispatch — adding a character fans out a dozen tasks with
  // one timestamp, so only its first row repeats the "when".
  firstOfBatch: boolean
  durationSeconds: number | null
}

// Newest first, with the batch grouping and duration the table renders.
export const activityRows = (tasks: readonly ActivityTask[]): ActivityRow[] =>
  [...tasks]
    .sort((a, b) =>
      a.created_at === b.created_at ? a.job.localeCompare(b.job) : b.created_at.localeCompare(a.created_at)
    )
    .map((task, index, sorted) => ({
      ...task,
      firstOfBatch: sorted[index - 1]?.batch_id !== task.batch_id,
      durationSeconds:
        task.started_at === null || task.ended_at === null
          ? null
          : Math.max(0, Math.round((new Date(task.ended_at).getTime() - new Date(task.started_at).getTime()) / 1000)),
    }))

// How recently a refresh_task must have been kicked to still colour its cell.
// Beyond this the cell goes back to reading its heartbeat: an on-demand error
// from this morning shouldn't outrank a scheduled pull that has since succeeded.
export const OVERLAY_MINUTES = 10

// A task left pending or running for this long isn't in flight any more — its
// run died before it could flip the row terminal. Rendering it as "running"
// forever would also pin the 2s poller on, so the page reads it as abandoned
// (see docs/cron-to-workflows/06-burn-in.md §2, which asked for exactly this
// rather than a sweeper job nobody reads).
export const ABANDONED_MINUTES = 60

export const isAbandoned = (task: ActivityTask, now: number = Date.now()): boolean =>
  (task.status === 'pending' || task.status === 'running') &&
  now - new Date(task.created_at).getTime() > ABANDONED_MINUTES * 60_000
