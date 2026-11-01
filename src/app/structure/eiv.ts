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
//   - Never for a job the journal billed (either side of the charge), so one
//     charge is never counted twice across the two sources.
//   - Only where no journal of the reader's covers the structure's owner —
//     decided at read time by measureWindow.ts, since which journals an
//     account holds is the account's business, not the rollup's.
//   - A job missing any input — no bill, an unpriced material, no index sample
//     — contributes nothing and is counted as unpriced, never guessed at.
//
// The alpha-clone surcharge (0.25%) is assumed absent: an alpha installing our
// jobs would inflate the recovered rate by exactly that much.
//
// These are the per-job primitives. The fold over an owner's jobs into daily
// rows is src/app/structure/measureRollup.ts (run by the extracts), and the
// sum of a window of those rows is src/app/structure/measureWindow.ts (run by
// the page).

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
  activity_id?: number | string | null
  blueprint_type_id?: number | string | null
  runs?: number | string | null
}

export type Bill = ReadonlyArray<{ typeID: number; quantity: number }>

export type EivPricing = {
  // blueprint_type_id -> ME0 material bill (sde_blueprint_product).
  bills: Readonly<Record<number, Bill>>
  // type_id -> CCP adjusted price (market_adjusted_price).
  prices: ReadonlyMap<number, number>
}

// What a structure's EIV measures add up to over a window.
export type StructureEiv = {
  // Total EIV of our manufacturing/reaction jobs installed here in the window.
  eiv: number
  jobs: number
  // The recovered facility tax, over the subset of jobs recovery could price.
  recoveredTax: number
  recoveredEiv: number
  recoveredJobs: number
}

// The recovered owner's rate for one structure, or null when recovery never
// ran (or the EIV base is degenerate). Zero is a real answer, not an absence:
// a private structure whose owner charges no facility tax recovers a tax of 0
// over a positive EIV, and hiding that read as "broken" on every tile where
// the landlord was simply free.
export const recoveredRate = (s: StructureEiv): number | null =>
  s.recoveredEiv > 0 ? s.recoveredTax / s.recoveredEiv : null

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

// Manufacturing and reactions push materials through a structure; nothing
// else does, so nothing else has an EIV worth summing.
export const isPriceable = (job: EivJob): boolean => {
  const activity = Number(job.activity_id)
  return activity === JOB_MANUFACTURING || activity === JOB_REACTION
}

// One job's worth: its EIV, or the input it lacked. Null when the job is not
// one either fold prices at all — not manufacturing or reaction, or no runs to
// scale by.
export type PricedJob = { eiv: number } | { missing: 'noBill' | 'noPrice' }

export const priceJobEiv = (job: EivJob, { bills, prices }: EivPricing): PricedJob | null => {
  if (!isPriceable(job)) return null
  const bill = job.blueprint_type_id != null ? bills[Number(job.blueprint_type_id)] : undefined
  if (bill == null) return { missing: 'noBill' }
  const runs = Number(job.runs)
  if (!Number.isFinite(runs) || runs <= 0) return null
  const eiv = priceBill(bill, runs, prices)
  return eiv == null ? { missing: 'noPrice' } : { eiv }
}

// The facility tax left once the index fee and SCC surcharge are taken out of
// what ESI billed. Clamped at zero: a stale index or a drifted adjusted price
// can push the arithmetic slightly negative, and a negative tax is not a thing
// the game charges.
export const recoverFacilityTax = (input: {
  eiv: number
  cost: number
  costIndex: number
  hullTypeId: number | null | undefined
}): number => {
  const indexFee = input.eiv * input.costIndex * hullCostMultiplier(input.hullTypeId)
  const scc = input.eiv * SCC_SURCHARGE
  return Math.max(0, input.cost - indexFee - scc)
}
