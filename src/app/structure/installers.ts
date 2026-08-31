// Who ran industry jobs at each structure — the fold behind the tile's
// Characters tab. Pure: the page hands it the two job lists and the name
// lookups it already has, and gets back one roster per structure, busiest
// first.
//
// Identity is the EVE character id wherever one is known, because the same
// person can appear through both extracts: their personal jobs carry our
// registration uuid, and jobs they installed for the corp carry their EVE id.
// A registration whose EVE id we know folds into that same key; one without
// (never extracted) stays under a registration-scoped key rather than being
// dropped.
import { forEach } from 'ramda'

import { jobLocationId, type JobLocation } from './roster.ts'

export type InstallerJob = JobLocation & {
  job_id: number | string
  start_date?: string | null
  // Character extract rows carry the registration uuid...
  registration_id?: string | null
  // ...corp extract rows carry the installer's EVE character id.
  installer_id?: number | string | null
}

export type InstallerInput = {
  // Structures with a tile; a job anywhere else contributes nothing.
  onPage: ReadonlySet<string>
  // ISO window start — the same window every other measure on the tile uses.
  since: string
  // registration uuid -> { name, characterId } for our own registrations.
  registrations: ReadonlyMap<string, { name: string; characterId: string | null }>
  // EVE character id -> name, from the universe_name cache.
  characterNames: ReadonlyMap<string, string>
  // job id -> the job's EIV, from the EIV fold. A job it couldn't price (or a
  // research job, which pushes no materials) contributes 0 — the roster keeps
  // the person, with the throughput it can vouch for.
  eivByJob: ReadonlyMap<string, number>
}

export type InstallerRow = { key: string; name: string; jobs: number; eiv: number }

export const foldInstallers = (jobs: readonly InstallerJob[], input: InstallerInput): Map<string, InstallerRow[]> => {
  const { onPage, since, registrations, characterNames, eivByJob } = input

  // structure -> installer key -> row. Both extracts can list one job (a
  // character's job at their corp's structure appears in each), so a job id is
  // counted once, preferring whichever row named the installer better.
  const byStructure = new Map<string, Map<string, InstallerRow>>()
  const counted = new Set<string>()

  forEach((job: InstallerJob) => {
    const structureId = jobLocationId(job)
    if (structureId == null || !onPage.has(structureId)) return
    if (job.start_date == null || job.start_date < since) return
    if (job.job_id == null || counted.has(String(job.job_id))) return
    counted.add(String(job.job_id))

    let key: string
    let name: string
    if (job.registration_id != null) {
      const reg = registrations.get(String(job.registration_id))
      key = reg?.characterId != null ? `char:${reg.characterId}` : `reg:${job.registration_id}`
      name = reg?.name ?? 'Unknown character'
    } else if (job.installer_id != null) {
      key = `char:${job.installer_id}`
      name = characterNames.get(String(job.installer_id)) ?? `Character #${job.installer_id}`
    } else {
      return
    }

    const roster = byStructure.get(structureId) ?? new Map<string, InstallerRow>()
    const row = roster.get(key) ?? { key, name, jobs: 0, eiv: 0 }
    row.jobs += 1
    row.eiv += eivByJob.get(String(job.job_id)) ?? 0
    // A corp row can know the name where an earlier fallback didn't.
    if (row.name.startsWith('Character #') && !name.startsWith('Character #')) row.name = name
    roster.set(key, row)
    byStructure.set(structureId, roster)
  }, jobs)

  return new Map(
    [...byStructure.entries()].map(([structureId, roster]) => [
      structureId,
      [...roster.values()].sort((a, b) => b.eiv - a.eiv || b.jobs - a.jobs || a.name.localeCompare(b.name)),
    ])
  )
}
