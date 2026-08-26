// The /jobs data assembly: heartbeats (completed and open), the caller's
// refresh_task rows and the registrations/corporations they belong to, folded
// into the per-job entity rows the page renders. Split out of page.tsx so
// /registration renders the same objects rather than a copy of this logic
// (docs/registrations-page/01-shared-data-seams.md).
//
// RLS scopes all of it: own registrations, own characters' and corps'
// heartbeats, the shared user_id-null rows every signed-in account sees. The
// caller passes its own client, following owners.ts.
import type { SupabaseClient } from '@supabase/supabase-js'
import { reduce } from 'ramda'

import { isChancellor } from '../account/settings/chancellor/chancellor'
import { jobsInSection } from './registry'
import { type ActivityTask, type EntityRun, OVERLAY_MINUTES, activityRows, isAbandoned, statusOf } from './rows'

export type Beat = {
  job: string
  registration_id: string | null
  corporation_id: number | null
  ended_at: string
  ok: boolean | null
  error: string | null
  // Set (with ok true) when the run was a permitted no-op: a corp endpoint the
  // character holds no in-game role for. See heartbeat.skipped_reason.
  skipped_reason: string | null
}

export type OpenBeat = { job: string; registration_id: string | null; corporation_id: number | null }

export type Task = ActivityTask & { registration_id: string | null }

export type Registration = { id: string; name: string; corporation_id: number | null; is_main: boolean }

export type JobsOverview = {
  registrations: Registration[]
  characterEntities: Record<string, EntityRun[]>
  corporationEntities: Record<string, EntityRun[]>
  accountBeats: Map<string, Beat>
  runFor: (job: string, key: string, beat: Beat | undefined) => Omit<EntityRun, 'id' | 'name'>
  activity: ReturnType<typeof activityRows>
  // Whether any corporation rows exist at all — the section is hidden without.
  corporationCount: number
  // Resolved corp names (universe_name) for the caller's corporations, for
  // callers that label registrations by corp rather than rendering the corp
  // entity rows (which carry their own resolved name already).
  corporationNames: Map<number, string>
  anyActive: boolean
  chancellor: boolean
  now: number
}

export const fetchJobsOverview = async (supabase: SupabaseClient, userId: string): Promise<JobsOverview> => {
  const chancellor = await isChancellor(userId)

  const now = Date.now()
  const openFloor = new Date(now - 60 * 60_000).toISOString()
  // Recent activity keeps a day; the per-cell overlay is much tighter, so an
  // on-demand error from this morning doesn't outrank a scheduled pull that has
  // since succeeded.
  const activityFloor = new Date(now - 24 * 60 * 60_000).toISOString()
  const overlayFloor = new Date(now - OVERLAY_MINUTES * 60_000).toISOString()

  const [{ data: registrationsData }, { data: beatsData }, { data: openData }, { data: tasksData }] = await Promise.all(
    [
      supabase
        .from('registration')
        .select('id, name, corporation_id, is_main')
        .order('created_at', { ascending: true }),
      supabase.rpc('latest_heartbeats'),
      // Open runs — started, not yet ended. This is what makes a *scheduled* run
      // visible as running; latest_heartbeats() returns completed rows only. The
      // floor drops rows whose end step never landed, which would otherwise read
      // as permanently running.
      supabase
        .from('heartbeat')
        .select('job, registration_id, corporation_id')
        .is('ended_at', null)
        .not('started_at', 'is', null)
        .gte('ran_at', openFloor),
      supabase
        .from('refresh_task')
        .select('id, batch_id, job, registration_id, character_name, status, error, created_at, started_at, ended_at')
        .gte('created_at', activityFloor)
        .order('created_at', { ascending: true }),
    ]
  )

  const registrations = (registrationsData ?? []) as Registration[]
  const beats = (beatsData ?? []) as Beat[]
  const openBeats = (openData ?? []) as OpenBeat[]
  const tasks = (tasksData ?? []) as Task[]

  const corporationOf = new Map(registrations.map((r) => [r.id, r.corporation_id]))

  // latest_heartbeats returns one row per job per owner. Character- and
  // account-scoped rows are already unique per cell; corp rows can appear once
  // per character that has ever run the corp's pull, so keep the newest — its
  // registration_id is whose token the extract actually ran under last time.
  const { charBeats, corpBeats, accountBeats, corpRunsAs } = reduce(
    (acc, b: Beat) => {
      if (b.corporation_id != null) {
        const key = `${b.job}:${b.corporation_id}`
        const prev = acc.corpBeats.get(key)
        if (!prev || prev.ended_at < b.ended_at) acc.corpBeats.set(key, b)
        // Whose token *worked*. A skipped row names a character who was turned
        // away for want of the in-game role, which is precisely who didn't run
        // it, so those never claim the Runs as column.
        if (b.skipped_reason == null) {
          const prevRun = acc.corpRunsAs.get(b.corporation_id)
          if (!prevRun || prevRun.ended_at < b.ended_at) acc.corpRunsAs.set(b.corporation_id, b)
        }
      } else if (b.registration_id != null) {
        acc.charBeats.set(`${b.job}:${b.registration_id}`, b)
      } else {
        acc.accountBeats.set(b.job, b)
      }
      return acc
    },
    {
      charBeats: new Map<string, Beat>(),
      corpBeats: new Map<string, Beat>(),
      accountBeats: new Map<string, Beat>(),
      corpRunsAs: new Map<number, Beat>(),
    },
    beats
  )

  // Same keying for the open rows: a corp run's heartbeat carries the
  // corporation, a per-character run its registration, a shared run neither.
  const openCells = new Set(openBeats.map((b) => `${b.job}:${b.corporation_id ?? b.registration_id ?? ''}`))

  // Index the just-kicked tasks by cell, later rows winning. A corp job's task
  // row carries its representative character, so key those by the corp instead.
  const corpJobNames = new Set(jobsInSection('corporation').map((entry) => entry.job))
  const taskByCell = reduce(
    (acc, t) => {
      if (t.created_at < overlayFloor || isAbandoned(t, now)) return acc
      const corpId = corpJobNames.has(t.job) && t.registration_id != null ? corporationOf.get(t.registration_id) : null
      return acc.set(`${t.job}:${corpId ?? t.registration_id ?? ''}`, t)
    },
    new Map<string, Task>(),
    tasks
  )
  const anyActive = tasks.some((t) => (t.status === 'pending' || t.status === 'running') && !isAbandoned(t, now))

  // The user's corporations, each with the registered characters in it (in
  // registration order — the representative dispatchRefresh would pick first).
  const corporations = reduce(
    (acc, r) => {
      if (r.corporation_id == null) return acc
      const group = acc.get(r.corporation_id)
      if (group) group.push(r)
      else acc.set(r.corporation_id, [r])
      return acc
    },
    new Map<number, Registration[]>(),
    registrations
  )

  const corporationIds = [...corporations.keys()]
  const { data: corpNamesData } = corporationIds.length
    ? await supabase.from('universe_name').select('id, name').in('id', corporationIds)
    : { data: [] }
  const corpName = new Map((corpNamesData ?? []).map((n) => [Number(n.id), n.name as string]))

  const runFor = (job: string, key: string, beat: Beat | undefined): Omit<EntityRun, 'id' | 'name'> => ({
    lastRunAt: beat?.ended_at ?? null,
    ...statusOf({
      task: taskByCell.get(`${job}:${key}`),
      open: openCells.has(`${job}:${key}`),
      beat: beat && { ok: beat.ok, error: beat.error, skippedReason: beat.skipped_reason },
    }),
  })

  const characterEntities: Record<string, EntityRun[]> = Object.fromEntries(
    jobsInSection('character').map((entry) => [
      entry.job,
      registrations.map((r) => ({
        id: r.id,
        name: r.name,
        ...runFor(entry.job, r.id, charBeats.get(`${entry.job}:${r.id}`)),
      })),
    ])
  )

  const corporationEntities: Record<string, EntityRun[]> = Object.fromEntries(
    jobsInSection('corporation').map((entry) => [
      entry.job,
      [...corporations.entries()].map(([corporationId, members]) => {
        const runsAs = corpRunsAs.get(corporationId)
        const owned = members.find((m) => m.id === runsAs?.registration_id)
        // Kick new pulls as the character the last one succeeded under when
        // it's ours; the workflow target carries the whole corp group either
        // way, so this only picks the row's representative.
        const representative = owned ?? members[0]
        // Nobody has run it here yet → name who *would* run it, so the column
        // still answers "under whose token" instead of blanking.
        const runsAsCorpmate = runsAs != null && owned == null
        return {
          // The refresh button dispatches against a registration of ours, so
          // the entity's id is the representative character's — the corp id is
          // only how its heartbeats are keyed.
          id: representative.id,
          name: corpName.get(corporationId) ?? `#${corporationId}`,
          runsAs: runsAsCorpmate ? null : representative.name,
          runsAsCorpmate,
          ...runFor(entry.job, String(corporationId), corpBeats.get(`${entry.job}:${corporationId}`)),
        }
      }),
    ])
  )

  return {
    registrations,
    characterEntities,
    corporationEntities,
    accountBeats,
    runFor,
    activity: activityRows(tasks),
    corporationCount: corporations.size,
    corporationNames: corpName,
    anyActive,
    chancellor,
    now,
  }
}
