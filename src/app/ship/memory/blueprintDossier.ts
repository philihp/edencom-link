// What a blueprint knows about itself (docs/ship-memory.md, "Extension: every
// singleton" → "Blueprint"). Every industry job carries blueprint_id, the
// blueprint's item id, so a blueprint's working life — its research, the
// hulls it has built, the copies it has made — is recorded against its own
// id with no inference at the join. This is the pure fold over those rows;
// the loader is loadBlueprint.ts, the tool memoryTools.ts.
//
// Every count is an at-least: the record starts when the job extract first
// ran for the owner, and ESI keeps about 90 days of jobs, so older work is
// on record only if an extract saw it. No I/O.
import { groupBy, sortBy } from 'ramda'

import type { Owner, Tenure } from './dossier.ts'

// One version of the blueprint row, from either blueprint history table.
// quantity is ESI's: -1 an original, -2 a copy, positive a packaged stack.
export type BlueprintVersion = {
  owner: Owner
  typeId: number
  quantity: number | null
  me: number | null
  te: number | null
  runs: number | null
  locationId: number | null
  locationFlag: string | null
  isCurrent: boolean
  validFrom: string
  validUntil: string
}

// One industry job run with the blueprint, from either job history table
// (one row per job: the loader keeps the newest version).
export type BlueprintJob = {
  jobId: number
  owner: Owner
  installerId: number
  activityId: number
  runs: number
  licensedRuns: number | null
  successfulRuns: number | null
  productTypeId: number | null
  facilityId: number
  cost: number | null
  status: string
  startDate: string
  endDate: string
}

// ESI's industry activity ids.
export const ACTIVITY = {
  manufacturing: 1,
  researchTe: 3,
  researchMe: 4,
  copying: 5,
  reverseEngineering: 7,
  invention: 8,
  reaction: 9,
} as const

export type BlueprintKind = 'original' | 'copy' | 'stack' | 'unknown'

export type Research = { me: number; te: number }

// One change of research level on the blueprint row, with the research job
// that produced it when one fits.
export type ResearchStep = {
  at: string
  from: Research
  to: Research
  jobId: number | null
}

export type JobTally = {
  // Every job on record that was not cancelled or reverted.
  jobs: number
  delivered: number
  // Runs over the delivered jobs.
  runsAtLeast: number
  costAtLeast: number | null
  first: string | null
  last: string | null
}

export type ProductTally = { productTypeId: number; jobs: number; runsAtLeast: number }
export type FacilityTally = { facilityId: number; jobs: number }
export type InstallerTally = { installerId: number; jobs: number }

export type BlueprintDossier = {
  itemId: number
  typeId: number
  kind: BlueprintKind
  research: { current: Research | null; steps: ResearchStep[] }
  researchJobs: JobTally & { me: number; te: number }
  building: JobTally & { byProduct: ProductTally[]; facilities: FacilityTally[]; installers: InstallerTally[] }
  copying: JobTally & { licensedRunsAtLeast: number }
  invention: JobTally & { successfulRunsAtLeast: number }
  // A copy's runs left, from its current row; null for an original.
  runsRemaining: number | null
  tenures: Tenure[]
  debut: { at: string; owner: Owner }
  inHangar: boolean
  lastSeen: string
  versions: number
}

const ms = (iso: string): number => new Date(iso).getTime()
const byValidFrom = <T extends { validFrom: string }>(rows: T[]): T[] => sortBy((r) => ms(r.validFrom), rows)
const sameOwner = (a: Owner, b: Owner): boolean => a.kind === b.kind && a.id === b.id

export const blueprintKind = (quantity: number | null): BlueprintKind =>
  quantity === -1 ? 'original' : quantity === -2 ? 'copy' : quantity != null && quantity > 0 ? 'stack' : 'unknown'

const researchOf = (v: BlueprintVersion): Research => ({ me: v.me ?? 0, te: v.te ?? 0 })
const sameResearch = (a: Research, b: Research): boolean => a.me === b.me && a.te === b.te

const live = (j: BlueprintJob): boolean => j.status !== 'cancelled' && j.status !== 'reverted'
const delivered = (j: BlueprintJob): boolean => j.status === 'delivered'

// Consecutive versions that agree on owner collapse into one tenure.
export const blueprintTenures = (versions: BlueprintVersion[]): Tenure[] =>
  byValidFrom(versions).reduce<Tenure[]>((acc, v) => {
    const last = acc[acc.length - 1]
    if (last && sameOwner(last.owner, v.owner)) last.until = v.isCurrent ? null : v.validUntil
    else acc.push({ owner: v.owner, from: v.validFrom, until: v.isCurrent ? null : v.validUntil })
    return acc
  }, [])

// Each change of ME or TE between consecutive versions is a step, dated at
// the version that shows it. The research job credited is the delivered one
// of the matching activity that ended between the two versions (nearest to
// the new version wins); a step with no such job (research done before the
// job extract watched, or in a corp whose jobs we cannot read) carries none.
export const researchSteps = (versions: BlueprintVersion[], jobs: BlueprintJob[]): ResearchStep[] => {
  const ordered = byValidFrom(versions)
  const research = jobs.filter(
    (j) => delivered(j) && (j.activityId === ACTIVITY.researchMe || j.activityId === ACTIVITY.researchTe)
  )
  return ordered.slice(1).flatMap((v, i) => {
    const prev = ordered[i]
    const from = researchOf(prev)
    const to = researchOf(v)
    if (sameResearch(from, to)) return []
    const activity = to.me !== from.me ? ACTIVITY.researchMe : ACTIVITY.researchTe
    const fits = research.filter(
      (j) => j.activityId === activity && ms(j.endDate) >= ms(prev.validFrom) && ms(j.endDate) <= ms(v.validFrom)
    )
    const job = sortBy((j) => ms(v.validFrom) - ms(j.endDate), fits)[0]
    return [{ at: v.validFrom, from, to, jobId: job?.jobId ?? null }]
  })
}

const tally = (jobs: BlueprintJob[]): JobTally => {
  const kept = jobs.filter(live)
  const done = kept.filter(delivered)
  const dated = sortBy((j) => ms(j.endDate), kept)
  const costs = done.map((j) => j.cost)
  return {
    jobs: kept.length,
    delivered: done.length,
    runsAtLeast: done.reduce((total, j) => total + j.runs, 0),
    costAtLeast:
      costs.length === 0 || costs.some((c) => c == null) ? null : costs.reduce<number>((t, c) => t + (c as number), 0),
    first: dated[0]?.startDate ?? null,
    last: dated[dated.length - 1]?.endDate ?? null,
  }
}

// Jobs grouped by a numeric key, as [key, jobs] pairs.
const groupedBy = (jobs: BlueprintJob[], keyOf: (j: BlueprintJob) => number): Array<[number, BlueprintJob[]]> =>
  Object.entries(groupBy((j: BlueprintJob) => String(keyOf(j)), jobs)).map(([key, rows]) => [Number(key), rows ?? []])

export const blueprintDossier = (input: {
  itemId: number
  versions: BlueprintVersion[]
  jobs: BlueprintJob[]
  lastSeen: string
}): BlueprintDossier | null => {
  const versions = byValidFrom(input.versions)
  if (versions.length === 0) return null
  const first = versions[0]
  const newest = versions[versions.length - 1]
  const jobs = input.jobs

  const manufacturing = jobs.filter(
    (j) => j.activityId === ACTIVITY.manufacturing || j.activityId === ACTIVITY.reaction
  )
  const research = jobs.filter((j) => j.activityId === ACTIVITY.researchMe || j.activityId === ACTIVITY.researchTe)
  const copying = jobs.filter((j) => j.activityId === ACTIVITY.copying)
  const invention = jobs.filter(
    (j) => j.activityId === ACTIVITY.invention || j.activityId === ACTIVITY.reverseEngineering
  )

  const liveBuilds = manufacturing.filter(live)
  const sortTally = <T extends { jobs: number }>(rows: T[]): T[] => sortBy((r) => -r.jobs, rows)

  return {
    itemId: input.itemId,
    typeId: newest.typeId,
    kind: blueprintKind(newest.quantity),
    research: {
      current: newest.me == null && newest.te == null ? null : researchOf(newest),
      steps: researchSteps(versions, jobs),
    },
    researchJobs: {
      ...tally(research),
      me: research.filter(live).filter((j) => j.activityId === ACTIVITY.researchMe).length,
      te: research.filter(live).filter((j) => j.activityId === ACTIVITY.researchTe).length,
    },
    building: {
      ...tally(manufacturing),
      byProduct: sortTally(
        groupedBy(liveBuilds, (j) => j.productTypeId ?? 0).map(([productTypeId, rows]) => ({
          productTypeId,
          jobs: rows.length,
          runsAtLeast: rows.filter(delivered).reduce((t, j) => t + j.runs, 0),
        }))
      ),
      facilities: sortTally(
        groupedBy(liveBuilds, (j) => j.facilityId).map(([facilityId, rows]) => ({ facilityId, jobs: rows.length }))
      ),
      installers: sortTally(
        groupedBy(liveBuilds, (j) => j.installerId).map(([installerId, rows]) => ({ installerId, jobs: rows.length }))
      ),
    },
    copying: {
      ...tally(copying),
      licensedRunsAtLeast: copying.filter(delivered).reduce((t, j) => t + (j.licensedRuns ?? 0) * j.runs, 0),
    },
    invention: {
      ...tally(invention),
      successfulRunsAtLeast: invention.filter(delivered).reduce((t, j) => t + (j.successfulRuns ?? 0), 0),
    },
    runsRemaining: blueprintKind(newest.quantity) === 'copy' ? newest.runs : null,
    tenures: blueprintTenures(versions),
    debut: { at: first.validFrom, owner: first.owner },
    inHangar: newest.isCurrent,
    lastSeen: input.lastSeen,
    versions: versions.length,
  }
}
