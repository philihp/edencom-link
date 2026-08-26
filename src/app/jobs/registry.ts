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
//   chancellor — gated on isChancellor() server-side. Every shared-universe job
//                that can be kicked at all is this: those pulls are game-wide,
//                so one account's button spends everyone's rate limit and moves
//                data nobody asked to move. refreshCell re-checks server-side.
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
  // The ESI OAuth scopes gating this job's pull, matching the SCOPE/SCOPES
  // constant of the job module under src/jobs/ (which can't be imported here —
  // the job modules drag in the cron-side ESI/DB plumbing). One entry for
  // every job but character-status, whose six live-state endpoints each have
  // their own (forEachCharacterAnyScope runs whichever the token carries), and
  // the shared-universe jobs, which pull public data under no grant at all.
  // /registration reads these to fuse grant state into each job cell.
  scopes: readonly string[]
}

export const JOBS: readonly JobEntry[] = [
  {
    job: 'character-assets',
    label: 'assets',
    section: 'character',
    kickable: 'always',
    scopes: ['esi-assets.read_assets.v1'],
  },
  {
    job: 'character-blueprints',
    label: 'blueprints',
    section: 'character',
    kickable: 'always',
    scopes: ['esi-characters.read_blueprints.v1'],
  },
  {
    job: 'character-orders',
    label: 'orders',
    section: 'character',
    kickable: 'always',
    scopes: ['esi-markets.read_character_orders.v1'],
  },
  {
    job: 'character-wallet-transactions',
    label: 'transactions',
    section: 'character',
    kickable: 'always',
    scopes: ['esi-wallet.read_character_wallet.v1'],
  },
  {
    job: 'character-contracts',
    label: 'contracts',
    section: 'character',
    kickable: 'always',
    scopes: ['esi-contracts.read_character_contracts.v1'],
  },
  {
    job: 'character-industry-jobs',
    label: 'industry',
    section: 'character',
    kickable: 'always',
    scopes: ['esi-industry.read_character_jobs.v1'],
  },
  {
    job: 'character-mercenary-dens',
    label: 'dens',
    section: 'character',
    kickable: 'always',
    scopes: ['esi-structures.read_character.v1'],
  },
  {
    job: 'character-fittings',
    label: 'fittings',
    section: 'character',
    kickable: 'always',
    scopes: ['esi-fittings.read_fittings.v1'],
  },
  // Combined live-state pull: wallet, location, implants, clones, ship, skills
  // in one invocation (src/jobs/characterStatus.js).
  {
    job: 'character-status',
    label: 'status',
    section: 'character',
    kickable: 'always',
    scopes: [
      'esi-wallet.read_character_wallet.v1',
      'esi-location.read_location.v1',
      'esi-clones.read_implants.v1',
      'esi-clones.read_clones.v1',
      'esi-location.read_ship_type.v1',
      'esi-skills.read_skills.v1',
    ],
  },

  {
    job: 'corp-assets',
    label: 'assets',
    section: 'corporation',
    kickable: 'always',
    scopes: ['esi-assets.read_corporation_assets.v1'],
  },
  {
    job: 'corp-industry-jobs',
    label: 'industry',
    section: 'corporation',
    kickable: 'always',
    scopes: ['esi-industry.read_corporation_jobs.v1'],
  },
  {
    job: 'corp-wallet-transactions',
    label: 'transactions',
    section: 'corporation',
    kickable: 'always',
    scopes: ['esi-wallet.read_corporation_wallets.v1'],
  },
  {
    job: 'corp-contracts',
    label: 'contracts',
    section: 'corporation',
    kickable: 'always',
    scopes: ['esi-contracts.read_corporation_contracts.v1'],
  },
  // Kickable since the structure-universe work: "refresh my structures" is the
  // lever the /structure page hangs off, and it dispatches this per corporation
  // alongside corp-assets, which carries the rigs (docs/structure-universe/design.md).
  {
    job: 'corp-structures',
    label: 'structures',
    section: 'corporation',
    kickable: 'always',
    scopes: ['esi-corporations.read_structures.v1'],
  },
  // The two remaining daily whole-corp pulls a per-character fan-out would only
  // ever redo once per character, so they're scheduled-only (see dispatchRefresh.ts).
  {
    job: 'corp-blueprints',
    label: 'blueprints',
    section: 'corporation',
    kickable: 'never',
    scopes: ['esi-corporations.read_blueprints.v1'],
  },
  {
    job: 'corp-wallet-journal',
    label: 'wallet journal',
    section: 'corporation',
    kickable: 'never',
    scopes: ['esi-wallet.read_corporation_wallets.v1'],
  },

  { job: 'sde-mirror', label: 'SDE mirror', section: 'universe', kickable: 'never', scopes: [] },
  { job: 'universe-names', label: 'names', section: 'universe', kickable: 'chancellor', scopes: [] },
  { job: 'universe-structures', label: 'structures', section: 'universe', kickable: 'never', scopes: [] },
  // Daily public-feed pull (ESI's public structure list + EVE Ref). Names
  // structures no token of ours can reach; see docs/structure-universe/design.md.
  { job: 'structure-directory', label: 'structure directory', section: 'universe', kickable: 'chancellor', scopes: [] },
  { job: 'character-directory', label: 'character directory', section: 'universe', kickable: 'chancellor', scopes: [] },
  { job: 'industry-systems', label: 'industry indexes', section: 'universe', kickable: 'chancellor', scopes: [] },
  // Hourly third-party price feed (appraise.gnf.lt), not ESI. Chancellor-kickable
  // like the other shared-universe pulls: one account's button spends everyone's
  // goodwill with someone else's bandwidth.
  { job: 'market-prices', label: 'market prices', section: 'universe', kickable: 'chancellor', scopes: [] },
  { job: 'market-adjusted-prices', label: 'adjusted prices', section: 'universe', kickable: 'chancellor', scopes: [] },
]

export const jobsInSection = (section: JobSection) => JOBS.filter((entry) => entry.section === section)

// The catalog entry for a job name, or undefined for anything this page doesn't
// list — which is also what makes it unkickable (see ./actions.ts).
export const jobEntry = (job: string): JobEntry | undefined => JOBS.find((entry) => entry.job === job)

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
// tightest cadence of any job listed here (1h, character-mercenary-dens) and
// well over any job's runtime.
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
