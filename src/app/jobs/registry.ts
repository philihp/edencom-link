// The job catalog behind /jobs (docs/jobs-page.md): what each extract job is
// called, which section it belongs to, whether the page may kick it, and — read
// straight out of vercel.json — when it runs next.
//
// The schedules are NOT restated here. vercel.json's `crons` array is what
// actually schedules these jobs, so it's imported and keyed by job name; a
// schedule change in one place can't drift from the other. A job with no
// vercel.json entry (character-skills, esf-data, sheet-csv, and the individual
// live-state modules) is manual-only and says so.

import { fromPairs, map } from 'ramda'

import vercel from '../../../vercel.json'
import { nextCronRun, previousCronRun } from './schedule'

export type JobSection = 'character' | 'corporation' | 'universe'

// Whether this page offers a refresh button for the job:
//   always     — anyone may kick it for their own characters/corps
//   chancellor — gated on isChancellor() server-side (whole-universe pull with
//                no per-character reason to run it; see refreshCell today)
//   never      — whole-corp/whole-universe work whose only trigger is the cron
//                (its ?force=1 / CRON_SECRET route stays an operator tool)
export type Kickable = 'always' | 'chancellor' | 'never'

export type JobEntry = {
  job: string
  // Short column label — the job names are named after their ESI endpoints and
  // are too wide to head a table with.
  label: string
  section: JobSection
  kickable: Kickable
}

export const JOBS: readonly JobEntry[] = [
  { job: 'character-assets', label: 'assets', section: 'character', kickable: 'always' },
  { job: 'character-blueprints', label: 'blueprints', section: 'character', kickable: 'always' },
  { job: 'character-orders', label: 'orders', section: 'character', kickable: 'always' },
  { job: 'character-wallet-transactions', label: 'transactions', section: 'character', kickable: 'always' },
  { job: 'character-industry-jobs', label: 'industry', section: 'character', kickable: 'always' },
  { job: 'character-mercenary-dens', label: 'dens', section: 'character', kickable: 'always' },
  // Combined live-state pull: wallet, location, implants, clones, ship, skills
  // in one invocation (src/jobs/characterStatus.js).
  { job: 'character-status', label: 'status', section: 'character', kickable: 'always' },

  { job: 'corp-assets', label: 'assets', section: 'corporation', kickable: 'always' },
  { job: 'corp-industry-jobs', label: 'industry', section: 'corporation', kickable: 'always' },
  { job: 'corp-wallet-transactions', label: 'transactions', section: 'corporation', kickable: 'always' },
  // The three daily whole-corp pulls a per-character fan-out would only ever
  // redo once per character, so they're scheduled-only (see dispatchRefresh.ts).
  { job: 'corp-structures', label: 'structures', section: 'corporation', kickable: 'never' },
  { job: 'corp-blueprints', label: 'blueprints', section: 'corporation', kickable: 'never' },
  { job: 'corp-wallet-journal', label: 'wallet journal', section: 'corporation', kickable: 'never' },

  { job: 'sde-mirror', label: 'SDE mirror', section: 'universe', kickable: 'never' },
  { job: 'universe-names', label: 'names', section: 'universe', kickable: 'always' },
  { job: 'universe-structures', label: 'structures', section: 'universe', kickable: 'never' },
  { job: 'character-directory', label: 'character directory', section: 'universe', kickable: 'always' },
  { job: 'industry-systems', label: 'industry indexes', section: 'universe', kickable: 'chancellor' },
]

export const jobsInSection = (section: JobSection) => JOBS.filter((entry) => entry.section === section)

// vercel.json's cron paths are all /api/cron/<job>, so the last segment is the
// job name this page keys everything else by.
const CRON_BY_JOB: Record<string, string> = fromPairs(
  map(
    (entry: { path: string; schedule: string }): [string, string] => [entry.path.replace(/^.*\//, ''), entry.schedule],
    vercel.crons
  )
)

// The 5-field UTC cron this job is scheduled with, or null when nothing in
// vercel.json triggers it (manual/backfill routes and the CLI only).
export const cronFor = (job: string): string | null => CRON_BY_JOB[job] ?? null

export const nextRunFor = (job: string, from: Date = new Date()): Date | null => {
  const cron = cronFor(job)
  return cron === null ? null : nextCronRun(cron, from)
}

// A run can start a little late and takes time to record its heartbeat, so a
// missed fire is only called out once it's this far past due. Well under the
// tightest cadence (6h) and well over any job's runtime.
const MISSED_GRACE_MINUTES = 30

// Did the last scheduled fire not happen? True when the previous time this cron
// should have run is meaningfully newer than the newest run we can see — the
// silent-cron failure mode that moved these jobs off GitHub Actions in the first
// place. Heuristic, deliberately: for a fan-out job we only see the caller's own
// characters, so this answers "my data missed its pull", not "the cron is down".
export const isOverdue = (job: string, lastRunAt: string | null | undefined, from: Date = new Date()): boolean => {
  const previous = previousCronRun(cronFor(job) ?? '', from)
  if (previous === null) return false
  const due = previous.getTime() + MISSED_GRACE_MINUTES * 60_000
  if (due > from.getTime()) return false
  return lastRunAt == null || new Date(lastRunAt).getTime() < previous.getTime()
}
