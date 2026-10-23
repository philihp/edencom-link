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
// Your Total EIV is simpler but the same in activity: the summed EIV of the
// manufacturing and reaction jobs our own characters installed at each
// structure, a throughput measure. The caller hands this fold only those jobs
// (eivJobSets' `ours`, below) — never a co-tenant's or an unregistered
// corpmate's. A research job pushes no materials through, so it
// contributes nothing by construction rather than by omission.
//
// The Characters tab prices wider: every job we can see there, co-tenants'
// included (eivJobSets' `priced`, through priceJobs), so each row shows what
// that pilot or corporation put through the structure.
import { filter, forEach, reduce } from 'ramda'

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
// refineries have no job-cost bonus.
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

// A job as the measures hold it: who installed it decides whether it counts
// toward the tile. A personal job names a registration; a corp job names the
// EVE character who installed it.
export type EivOwnedJob = EivJob & {
  registration_id?: string | null
  installer_id?: number | string | null
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

// What pricing a job needs, and all the Characters tab's map needs.
export type EivPricing = Pick<EivInput, 'onPage' | 'since' | 'bills' | 'prices'>

const isPriceable = (job: EivJob): boolean => {
  const activity = Number(job.activity_id)
  return activity === JOB_MANUFACTURING || activity === JOB_REACTION
}

// The two job sets the EIV measures price, from every job we can see.
//
//   priced — every manufacturing and reaction job, co-tenants' included: the
//            Characters tab's EIV column (priceJobs).
//   ours   — the subset our own characters installed: a personal job of one of
//            our registrations, or a corp job whose installer is one of our
//            characters. The tile's Your Total EIV and the recovered tax
//            (foldEiv). Not "every corp job of an own corporation": that admits
//            jobs installed by corpmates we hold no registration for.
//
// Two sets, because one set did both jobs once: narrowing it to our own
// installs for the tile blanked every co-tenant's row on the tab as well.
export const eivJobSets = <J extends EivOwnedJob>(
  jobs: readonly J[],
  own: { registrationIds: ReadonlySet<string>; characterIds: ReadonlySet<string> }
): { priced: readonly J[]; ours: readonly J[] } => {
  const installedByUs = (job: J) =>
    (job.registration_id != null && own.registrationIds.has(String(job.registration_id))) ||
    (job.installer_id != null && own.characterIds.has(String(job.installer_id)))
  const priced = filter(isPriceable, jobs)
  return { priced, ours: filter(installedByUs, priced) }
}

// One job's place and worth: the structure it counts toward and its EIV, or the
// input it lacked. Null when the job is not one either fold prices at all —
// not manufacturing or reaction, not at a structure with a tile, installed
// before the window — or has no runs to scale by.
type Priced =
  { structureId: string; startDate: string; eiv: number } | { structureId: string; missing: 'noBill' | 'noPrice' }

const priceJob = (job: EivJob, { onPage, since, bills, prices }: EivPricing): Priced | null => {
  if (!isPriceable(job) || job.job_id == null) return null
  const structureId = job.station_id ?? job.facility_id
  if (structureId == null || !onPage.has(String(structureId))) return null
  if (job.start_date == null || job.start_date < since) return null
  const key = String(structureId)
  const bill = job.blueprint_type_id != null ? bills[Number(job.blueprint_type_id)] : undefined
  if (bill == null) return { structureId: key, missing: 'noBill' }
  const runs = Number(job.runs)
  if (!Number.isFinite(runs) || runs <= 0) return null
  const eiv = priceBill(bill, runs, prices)
  return eiv == null ? { structureId: key, missing: 'noPrice' } : { structureId: key, startDate: job.start_date, eiv }
}

// job id -> EIV for every job handed in that could be priced, whoever ran it.
// The Characters tab reads this over eivJobSets' `priced`; foldEiv sums only
// the jobs it is handed, and the tile hands it `ours`. A job both extracts list
// is the same job either way, so it lands on one key.
export const priceJobs = (jobs: readonly EivJob[], pricing: EivPricing): Map<string, number> =>
  reduce(
    (acc: Map<string, number>, job: EivJob) => {
      const priced = priceJob(job, pricing)
      return priced != null && 'eiv' in priced ? acc.set(String(job.job_id), priced.eiv) : acc
    },
    new Map<string, number>(),
    jobs
  )

export const foldEiv = (jobs: readonly EivJob[], input: EivInput): EivResult => {
  const { indexSamples, systemOf, hullOf, journalCoveredStructureIds, journalPaidJobIds } = input

  const byStructure = new Map<string, StructureEiv>()
  const skipped = { noBill: 0, noPrice: 0, noIndex: 0 }
  // The character and corp extracts can both list one job; one job is priced
  // once — the same reason the tax fold keeps `credited`/`paid` sets.
  const counted = new Set<string>()

  forEach((job: EivJob) => {
    const priced = priceJob(job, input)
    if (priced == null || counted.has(String(job.job_id))) return
    counted.add(String(job.job_id))
    if ('missing' in priced) {
      skipped[priced.missing] += 1
      return
    }

    const { structureId: key, startDate, eiv } = priced
    const activity = Number(job.activity_id)
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
      systemId != null ? indexAt(indexSamples.get(`${systemId}:${INDEX_ACTIVITY[activity]}`), startDate) : null
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
  return { byStructure, totalEiv, totalRecoveredTax, skipped }
}
