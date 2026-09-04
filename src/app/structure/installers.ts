// Who ran industry jobs at each structure — the fold behind the tile's
// Characters tab. Pure: the page hands it the two job lists and the name
// lookups it already has, and gets back one roster per structure, busiest
// first.
//
// The two extracts group differently, because that is how much each one
// actually tells us about who is behind a job:
//
//   * A personal job names one of our own registrations, and the registration
//     names a character. That character IS the row — see below.
//   * A corp job names the corporation it was installed for, and an installer
//     whose account we know nothing about. The corporation is the honest unit
//     there, and it is also the one that owns the output, so a corp job counts
//     for the corp even when one of our own characters installed it.
//
// **Personal jobs are one row per character, deliberately.** An earlier version
// folded every registration on the account into one row under the account's
// main, on the reading that they are all the same person. They are not
// necessarily: an account can hold the characters of several people sharing one
// tracker, and `registration.is_main` cannot tell them apart — it is ONE main
// per account (setting it clears every other row for that user), so the fold
// collapsed nine people's work into a single line and hid eight of them.
// Grouping by person needs a per-character main the schema does not have.
import { forEach } from 'ramda'

import { jobLocationId, type JobLocation } from './roster.ts'

export type InstallerJob = JobLocation & {
  job_id: number | string
  start_date?: string | null
  // Character extract rows carry the registration uuid...
  registration_id?: string | null
  // ...corp extract rows carry the corporation the job was run for, and the
  // EVE character id of whoever installed it.
  corporation_id?: number | string | null
  installer_id?: number | string | null
}

export type InstallerInput = {
  // Structures with a tile; a job anywhere else contributes nothing.
  onPage: ReadonlySet<string>
  // ISO window start — the same window every other measure on the tile uses.
  since: string
  // registration uuid -> { name, characterId }: who a personal job's row is.
  registrations: ReadonlyMap<string, { name: string; characterId: string | null }>
  // corporation id -> name, from the `corporation` directory.
  corporationNames: ReadonlyMap<string, string>
  // job id -> the job's EIV, from the EIV fold. A job it couldn't price (or a
  // research job, which pushes no materials) contributes 0 — the roster keeps
  // the row, with the throughput it can vouch for.
  eivByJob: ReadonlyMap<string, number>
}

export type InstallerRow = {
  key: string
  name: string
  // What the row stands for, so the tile can say so rather than implying every
  // line is one pilot.
  kind: 'character' | 'corporation'
  jobs: number
  eiv: number
  // Distinct characters folded into the row. More than one is the whole point
  // of grouping, and worth showing; one means the row is just that person.
  characters: number
}

// Where a job counts, resolved before anything is folded. Both extracts can
// list one job (a character's job at their corp's structure appears in each),
// so this is also the dedup: one entry per job id, and a corp attribution wins
// over a personal one, since "it came in as a corp job" is what decides the
// grouping.
type Attribution = {
  structureId: string
  key: string
  name: string
  kind: InstallerRow['kind']
  // The character behind this particular job, for the distinct-character count.
  // Null when the extract named no one (a registration we have never resolved).
  characterKey: string | null
  fromCorp: boolean
}

const attribute = (job: InstallerJob, input: InstallerInput): Attribution | null => {
  const structureId = jobLocationId(job)
  if (structureId == null || !input.onPage.has(structureId)) return null
  if (job.start_date == null || job.start_date < input.since) return null
  if (job.job_id == null) return null

  // A corp job groups by its corporation. Only a corp row carries
  // corporation_id (the character select doesn't ask for it), so this is the
  // discriminator as well as the grouping key.
  if (job.corporation_id != null) {
    const corporationId = String(job.corporation_id)
    return {
      structureId,
      key: `corp:${corporationId}`,
      name: input.corporationNames.get(corporationId) ?? `Corporation #${corporationId}`,
      kind: 'corporation',
      characterKey: job.installer_id != null ? String(job.installer_id) : null,
      fromCorp: true,
    }
  }

  if (job.registration_id != null) {
    const registrationId = String(job.registration_id)
    const registration = input.registrations.get(registrationId)
    return {
      structureId,
      key: registration?.characterId != null ? `char:${registration.characterId}` : `reg:${registrationId}`,
      name: registration?.name ?? 'Unknown character',
      kind: 'character',
      characterKey: registration?.characterId ?? `reg:${registrationId}`,
      fromCorp: false,
    }
  }

  // A corp row that names no corporation (nothing in the extract does today)
  // still belongs to whoever installed it rather than being dropped.
  if (job.installer_id != null) {
    const installerId = String(job.installer_id)
    return {
      structureId,
      key: `char:${installerId}`,
      name: `Character #${installerId}`,
      kind: 'character',
      characterKey: installerId,
      fromCorp: false,
    }
  }

  return null
}

export const foldInstallers = (jobs: readonly InstallerJob[], input: InstallerInput): Map<string, InstallerRow[]> => {
  // One attribution per job id, corp winning — see Attribution above.
  const byJob = new Map<string, Attribution>()
  forEach((job: InstallerJob) => {
    const attribution = attribute(job, input)
    if (!attribution) return
    const jobId = String(job.job_id)
    const held = byJob.get(jobId)
    if (held && (held.fromCorp || !attribution.fromCorp)) return
    byJob.set(jobId, attribution)
  }, jobs)

  // structure -> row key -> row, with the contributing characters kept as a set
  // so the count is distinct rather than per job.
  const byStructure = new Map<string, Map<string, InstallerRow & { seen: Set<string> }>>()
  forEach(
    ([jobId, attribution]: [string, Attribution]) => {
      const roster = byStructure.get(attribution.structureId) ?? new Map<string, InstallerRow & { seen: Set<string> }>()
      const row = roster.get(attribution.key) ?? {
        key: attribution.key,
        name: attribution.name,
        kind: attribution.kind,
        jobs: 0,
        eiv: 0,
        characters: 0,
        seen: new Set<string>(),
      }
      row.jobs += 1
      row.eiv += input.eivByJob.get(jobId) ?? 0
      if (attribution.characterKey != null) row.seen.add(attribution.characterKey)
      roster.set(attribution.key, row)
      byStructure.set(attribution.structureId, roster)
    },
    [...byJob.entries()]
  )

  return new Map(
    [...byStructure.entries()].map(([structureId, roster]) => [
      structureId,
      [...roster.values()]
        .map(({ seen, ...row }) => ({ ...row, characters: seen.size }))
        .sort((a, b) => b.eiv - a.eiv || b.jobs - a.jobs || a.name.localeCompare(b.name)),
    ])
  )
}
