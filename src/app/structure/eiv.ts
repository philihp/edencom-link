// Estimated Item Value per industry job, and what it unlocks: splitting a job's
// `cost` into its parts, which is the only way to know the facility tax at a
// structure whose wallet we cannot read.
//
// The game computes a job's install cost as
//
//   cost = EIV × (system cost index × hull bonus + facility tax + SCC surcharge)
//
// where EIV is the job's ME0 material bill priced at CCP's adjusted price
// (never market price). With the market-adjusted-prices extract feeding
// `market_adjusted_price`, every term but the facility tax is now knowable:
//
//   EIV        = runs × Σ (ME0 quantity × adjusted_price)   [sde_blueprint_product]
//   index      = the system's cost index when the job was installed
//                                                          [industry_system_index]
//   hull bonus = the structure hull's job-cost reduction    [type_id]
//   SCC        = a flat 4%, a sink paid to nobody
//
// so the remainder IS the facility tax, and remainder ÷ EIV is the owner's rate
// — the number a rented structure's owner sets but ESI publishes nowhere.
//
// Recovery is deliberately narrow:
//   - Manufacturing and reaction jobs only. Research/copy/invention charge on a
//     different EIV base (the product's, at a 2% job-cost multiplier), so the
//     inversion doesn't hold — docs/cost-avoidance.md makes the same carve-out.
//   - Only at structures our corporations do NOT own. Our own receipts are in
//     the journal, exact; an estimate would be strictly worse.
//   - Never for a job the journal already billed (an outgoing corp entry), so
//     one charge is never counted twice across the two sources.
//   - A job missing any input — no bill, an unpriced material, no index sample
//     — contributes nothing and is counted as skipped, never guessed at.
//
// The alpha-clone surcharge (0.25%) is assumed absent: an alpha installing our
// jobs would inflate the recovered rate by exactly that much.
//
// Total EIV is simpler and broader in ownership but the same in activity: the
// summed EIV of our manufacturing and reaction jobs at each structure, a
// throughput measure. A research job pushes no materials through, so it
// contributes nothing by construction rather than by omission.
import { forEach } from 'ramda'

// ESI *job* activity ids (src/app/industry/jobFields.ts): manufacturing 1,
// reactions 9. The SDE numbers reactions 11 (src/sdeBlueprints.ts REACTION),
// but sde_blueprint_product rows are keyed by blueprint type id, so the job's
// activity only gates *whether* to price, not which bill to use.
const JOB_MANUFACTURING = 1
const JOB_REACTION = 9

// industry_system_index.activity strings, as ESI /industry/systems names them.
export const INDEX_ACTIVITY: Record<number, string> = {
  [JOB_MANUFACTURING]: 'manufacturing',
  [JOB_REACTION]: 'reaction',
}

// The SCC surcharge on every industry job: EIV × 4%, an ISK sink paid to
// nobody (docs/cost-avoidance.md).
export const SCC_SURCHARGE = 0.04

// Job-cost reduction from the structure hull itself: engineering complexes
// discount the index term by 3/4/5% (Raitaru/Azbel/Sotiyo). Citadels and
// refineries have no job-cost bonus. Same type ids as silhouette.tsx.
const HULL_COST_MULTIPLIER: Record<number, number> = {
  35825: 0.97, // Raitaru
  35826: 0.96, // Azbel
  35827: 0.95, // Sotiyo
}

export const hullCostMultiplier = (typeId: number | null | undefined): number =>
  (typeId != null ? HULL_COST_MULTIPLIER[Number(typeId)] : undefined) ?? 1

export type EivJob = {
  job_id: number | string
  activity_id?: number | string | null
  blueprint_type_id?: number | string | null
  runs?: number | string | null
  cost?: number | string | null
  start_date?: string | null
  station_id?: number | string | null
  facility_id?: number | string | null
}

export type Bill = ReadonlyArray<{ typeID: number; quantity: number }>

export type IndexSample = { recordedAt: string; costIndex: number }

export type EivInput = {
  // Structure ids with a tile on the page; a job anywhere else contributes
  // nothing, exactly as it does in the tax fold.
  onPage: ReadonlySet<string>
  // ISO window start; jobs are windowed on installation, when the ISK left.
  since: string
  // blueprint_type_id -> ME0 material bill (sde_blueprint_product).
  bills: Readonly<Record<number, Bill>>
  // type_id -> CCP adjusted price (market_adjusted_price).
  prices: ReadonlyMap<number, number>
  // `${system_id}:${activity}` -> samples ordered by recordedAt ascending.
  indexSamples: ReadonlyMap<string, readonly IndexSample[]>
  // structure id -> system id, for the index lookup.
  systemOf: ReadonlyMap<string, string>
  // structure id -> hull type id, for the job-cost bonus.
  hullOf: ReadonlyMap<string, number | null>
  // Structures whose facility tax the corp wallet journal actually bills for us:
  // EIV still counts, recovery never runs, because the journal is the exact
  // record there and estimating on top of it would double-count.
  //
  // This is journal *coverage*, not ownership, and the two come apart. A
  // structure owned by a corporation we merely have a character in is not
  // covered unless some token of ours holds the wallet roles to read that
  // corporation's journal — and where it does not, suppressing recovery hides
  // the charge entirely, because nothing else can see it either. The caller
  // decides which corporations qualify; see src/app/structure/page.tsx.
  journalCoveredStructureIds: ReadonlySet<string>
  // Jobs whose tax the journal already billed as an outgoing corp entry.
  journalPaidJobIds: ReadonlySet<string>
}

export type StructureEiv = {
  // Total EIV of our manufacturing/reaction jobs installed here in the window.
  eiv: number
  jobs: number
  // The recovered facility tax, over the subset of jobs recovery could price.
  recoveredTax: number
  recoveredEiv: number
  recoveredJobs: number
}

export type EivResult = {
  byStructure: Map<string, StructureEiv>
  // job id -> that job's EIV, for every job the fold priced. What lets the
  // Characters tab attribute throughput to installers without re-pricing.
  eivByJob: Map<string, number>
  totalEiv: number
  totalRecoveredTax: number
  // Jobs that would have counted but were missing an input. Surfaced so a
  // stale extract reads as "n jobs unpriced", never as a smaller number.
  skipped: { noBill: number; noPrice: number; noIndex: number }
}

// The recovered owner's rate for one structure, or null when recovery never
// ran (or the EIV base is degenerate). Zero is a real answer, not an absence:
// a private structure whose owner charges no facility tax recovers a tax of 0
// over a positive EIV, and hiding that read as "broken" on every tile where
// the landlord was simply free.
export const recoveredRate = (s: StructureEiv): number | null =>
  s.recoveredEiv > 0 ? s.recoveredTax / s.recoveredEiv : null

// Latest sample at or before `iso`, else the earliest after it — the index is
// hourly and slow-moving, so the nearest observation is the honest stand-in
// for a moment we weren't yet tracking the system.
export const indexAt = (samples: readonly IndexSample[] | undefined, iso: string): number | null => {
  if (!samples || samples.length === 0) return null
  let best: IndexSample | null = null
  for (const sample of samples) {
    if (sample.recordedAt <= iso) best = sample
    else break
  }
  return (best ?? samples[0]).costIndex
}

// EIV of one bill at ME0: quantities are per single run, so scale by runs.
// Any unpriced material refuses the whole job rather than under-pricing it —
// the same posture the appraisal tools take.
const priceBill = (bill: Bill, runs: number, prices: ReadonlyMap<number, number>): number | null => {
  let sum = 0
  for (const { typeID, quantity } of bill) {
    const price = prices.get(Number(typeID))
    if (price == null || !Number.isFinite(price)) return null
    sum += quantity * price
  }
  return sum * runs
}

export const foldEiv = (jobs: readonly EivJob[], input: EivInput): EivResult => {
  const {
    onPage,
    since,
    bills,
    prices,
    indexSamples,
    systemOf,
    hullOf,
    journalCoveredStructureIds,
    journalPaidJobIds,
  } = input

  const byStructure = new Map<string, StructureEiv>()
  const eivByJob = new Map<string, number>()
  const skipped = { noBill: 0, noPrice: 0, noIndex: 0 }
  // The character and corp extracts can both list one job; one job is priced
  // once — the same reason the tax fold keeps `credited`/`paid` sets.
  const counted = new Set<string>()

  forEach((job: EivJob) => {
    const activity = Number(job.activity_id)
    if (activity !== JOB_MANUFACTURING && activity !== JOB_REACTION) return
    const structureId = job.station_id ?? job.facility_id
    if (structureId == null || !onPage.has(String(structureId))) return
    if (job.start_date == null || job.start_date < since) return
    if (job.job_id == null || counted.has(String(job.job_id))) return
    counted.add(String(job.job_id))

    const key = String(structureId)
    const runs = Number(job.runs)
    const bill = job.blueprint_type_id != null ? bills[Number(job.blueprint_type_id)] : undefined
    if (bill == null) {
      skipped.noBill += 1
      return
    }
    if (!Number.isFinite(runs) || runs <= 0) return
    const eiv = priceBill(bill, runs, prices)
    if (eiv == null) {
      skipped.noPrice += 1
      return
    }

    eivByJob.set(String(job.job_id), eiv)
    const row = byStructure.get(key) ?? { eiv: 0, jobs: 0, recoveredTax: 0, recoveredEiv: 0, recoveredJobs: 0 }
    row.eiv += eiv
    row.jobs += 1
    byStructure.set(key, row)

    // Recovery: only where no journal of ours bills the charge, only for a job
    // the journal didn't already record, and only with a real cost to invert.
    const cost = Number(job.cost)
    if (
      journalCoveredStructureIds.has(key) ||
      journalPaidJobIds.has(String(job.job_id)) ||
      !Number.isFinite(cost) ||
      cost <= 0
    ) {
      return
    }
    const systemId = systemOf.get(key)
    const index =
      systemId != null ? indexAt(indexSamples.get(`${systemId}:${INDEX_ACTIVITY[activity]}`), job.start_date) : null
    if (index == null) {
      skipped.noIndex += 1
      return
    }
    const indexFee = eiv * index * hullCostMultiplier(hullOf.get(key))
    const scc = eiv * SCC_SURCHARGE
    // The remainder is the facility tax. Clamped at zero: a stale index or a
    // drifted adjusted price can push the arithmetic slightly negative, and a
    // negative tax is not a thing the game charges.
    const tax = Math.max(0, cost - indexFee - scc)
    row.recoveredTax += tax
    row.recoveredEiv += eiv
    row.recoveredJobs += 1
  }, jobs)

  let totalEiv = 0
  let totalRecoveredTax = 0
  byStructure.forEach((row) => {
    totalEiv += row.eiv
    totalRecoveredTax += row.recoveredTax
  })
  return { byStructure, eivByJob, totalEiv, totalRecoveredTax, skipped }
}
