// TEMPORARY — mock data so /jobs renders while the layout is being argued
// about. **The implementing PR deletes this file** and replaces each use with
// the query named in the TODO(jobs-page) comment beside it in page.tsx.
//
// The fake runs are pinned to each job's *real* schedule rather than to a
// hardcoded "2 hours ago": a run lands a couple of minutes after the job's most
// recent scheduled fire, so the page looks plausible whatever time of day it's
// opened, and a job deliberately made to miss its last fire lights up the
// overdue state instead of every daily job doing so by accident.

import { cronFor } from './registry'
import { previousCronRun } from './schedule'

export type StubEntityRun = {
  id: string
  name: string
  lastRunAt: string | null
  // Whose token the pull ran under (corp jobs only). null → nobody has run it
  // yet; runsAsCorpmate → a director on another account in the same corp,
  // visible as a corp-scoped heartbeat but not as one of our registrations.
  runsAs?: string | null
  runsAsCorpmate?: boolean
  status?: 'queued' | 'running' | 'failed'
}

export type StubActivity = {
  id: string
  batchId: string
  job: string
  forWhom: string | null
  enqueuedAt: string
  status: 'pending' | 'running' | 'done' | 'error'
  durationSeconds: number | null
  error: string | null
}

const MINUTE_MS = 60_000

// A run that happened `late` minutes after the job's most recent scheduled fire.
const afterLastFire = (job: string, late = 2): string | null => {
  const previous = previousCronRun(cronFor(job) ?? '', new Date())
  return previous === null ? null : new Date(previous.getTime() + late * MINUTE_MS).toISOString()
}

// A run that last happened one fire *earlier* than it should have — i.e. the
// most recent scheduled fire produced nothing. This is what trips isOverdue.
const missedLastFire = (job: string, late = 2): string | null => {
  const cron = cronFor(job) ?? ''
  const previous = previousCronRun(cron, new Date())
  if (previous === null) return null
  const beforeThat = previousCronRun(cron, new Date(previous.getTime() - MINUTE_MS))
  return beforeThat === null ? null : new Date(beforeThat.getTime() + late * MINUTE_MS).toISOString()
}

const ago = (minutes: number) => new Date(Date.now() - minutes * MINUTE_MS).toISOString()

const characters = (job: string, overrides: Partial<Record<'c1' | 'c2' | 'c3', Partial<StubEntityRun>>> = {}) => [
  { id: 'c1', name: 'Philihp Boeing', lastRunAt: afterLastFire(job), ...overrides.c1 },
  { id: 'c2', name: 'Amarrian Hauler', lastRunAt: afterLastFire(job, 3), ...overrides.c2 },
  { id: 'c3', name: 'Jita Alt', lastRunAt: afterLastFire(job, 4), ...overrides.c3 },
]

// Three characters. Two of them deliberately disagree with the rest — Jita Alt
// missed the last assets pull (the "1 lagging" note), and Amarrian Hauler has
// never had dens extracted at all.
export const STUB_CHARACTERS: Record<string, StubEntityRun[]> = {
  'character-assets': characters('character-assets', { c3: { lastRunAt: missedLastFire('character-assets') } }),
  'character-blueprints': characters('character-blueprints'),
  'character-orders': characters('character-orders'),
  'character-wallet-transactions': characters('character-wallet-transactions'),
  'character-industry-jobs': characters('character-industry-jobs', { c1: { status: 'running' } }),
  'character-mercenary-dens': characters('character-mercenary-dens', { c2: { lastRunAt: null } }),
  'character-status': characters('character-status'),
}

// Two corps: one where we hold the director token, one where a corpmate on
// another account does — the case the Runs as column exists for.
const corporations = (job: string, overrides: Partial<Record<'k1' | 'k2', Partial<StubEntityRun>>> = {}) => [
  { id: 'k1', name: 'Boeing Industries', lastRunAt: afterLastFire(job), runsAs: 'Philihp Boeing', ...overrides.k1 },
  {
    id: 'k2',
    name: 'Wandering Nomads',
    lastRunAt: afterLastFire(job, 4),
    runsAs: null,
    runsAsCorpmate: true,
    ...overrides.k2,
  },
]

export const STUB_CORPORATIONS: Record<string, StubEntityRun[]> = {
  'corp-assets': corporations('corp-assets'),
  'corp-industry-jobs': corporations('corp-industry-jobs'),
  'corp-wallet-transactions': corporations('corp-wallet-transactions'),
  // Neither corp got its last fire — the overdue state, which is about the
  // schedule rather than about one entity lagging.
  'corp-structures': corporations('corp-structures', {
    k1: { lastRunAt: missedLastFire('corp-structures') },
    k2: { lastRunAt: missedLastFire('corp-structures', 4) },
  }),
  // Never run for the second corp: no director token there carries the
  // blueprints scope, so Runs as names who *would* run it instead of blanking.
  'corp-blueprints': corporations('corp-blueprints', {
    k2: { lastRunAt: null, runsAs: 'Amarrian Hauler', runsAsCorpmate: false },
  }),
  'corp-wallet-journal': corporations('corp-wallet-journal'),
}

// The shared jobs — one row each, no per-entity breakdown. universe-structures
// is the deliberately overdue one.
export const STUB_UNIVERSE: Record<string, string | null> = {
  'sde-mirror': afterLastFire('sde-mirror', 6),
  'universe-names': afterLastFire('universe-names'),
  'universe-structures': missedLastFire('universe-structures'),
  'character-directory': afterLastFire('character-directory'),
  'industry-systems': afterLastFire('industry-systems'),
}

export const STUB_ACTIVITY: StubActivity[] = [
  {
    id: 't1',
    batchId: 'b1',
    job: 'character-assets',
    forWhom: 'Jita Alt',
    enqueuedAt: ago(3),
    status: 'running',
    durationSeconds: null,
    error: null,
  },
  {
    id: 't2',
    batchId: 'b1',
    job: 'character-blueprints',
    forWhom: 'Jita Alt',
    enqueuedAt: ago(3),
    status: 'done',
    durationSeconds: 8,
    error: null,
  },
  {
    id: 't3',
    batchId: 'b2',
    job: 'corp-assets',
    forWhom: 'Wandering Nomads',
    enqueuedAt: ago(96),
    status: 'error',
    durationSeconds: 2,
    error: '403 Forbidden — character does not have required role(s)',
  },
  {
    id: 't4',
    batchId: 'b3',
    job: 'universe-names',
    forWhom: null,
    enqueuedAt: ago(310),
    status: 'done',
    durationSeconds: 31,
    error: null,
  },
]
