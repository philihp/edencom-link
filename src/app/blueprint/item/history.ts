// What one blueprint has done (docs/item-pages.md, "/blueprint/[itemId]"): the
// jobs it ran, folded into the page's rows and totals. Pure — jobs and a
// pricing function in, rows and totals out — so it is unit-tested, and the
// loader can later price a run at its install day's adjusted price (PR 4)
// without the fold changing. Relative imports with the extension: the test
// runner is plain Node, with no '@/*' alias.
import { ACTIVITY_NAMES } from '../../industry/jobFields.ts'
import { isPriceable, type Bill } from '../../structure/eiv.ts'

// ESI job activity ids. Manufacturing and reactions make units; copying makes
// copies; invention makes copies of another type; the two research
// activities improve the blueprint itself.
export const ACTIVITY = {
  manufacturing: 1,
  teResearch: 3,
  meResearch: 4,
  copying: 5,
  invention: 8,
  reaction: 9,
} as const

// A job as either job view lists it. Bigints arrive as strings from PostgREST.
export type HistoryJob = {
  job_id: number | string
  activity_id: number | string
  blueprint_type_id: number | string
  product_type_id: number | string | null
  runs: number | string
  licensed_runs?: number | string | null
  successful_runs?: number | string | null
  status: string
  start_date: string
  end_date: string
  completed_date?: string | null
  station_id?: number | string | null
  facility_id?: number | string | null
  // Who the job belongs to: a registration uuid or a corporation id.
  owner_id: string
}

// What a run made, by activity.
export type Made =
  // Manufacturing and reactions: runs × the SDE's product quantity.
  | { kind: 'units'; typeId: number; quantity: number }
  // Copying: one copy per run, each with the licensed runs the job set.
  | { kind: 'copies'; typeId: number; copies: number; licensedRuns: number | null }
  // Invention: the copies that came out, of the invented type, over the
  // attempts made.
  | { kind: 'invented'; typeId: number | null; successes: number | null; attempts: number }
  // ME/TE research: the levels gained.
  | { kind: 'research'; levels: number }
  | { kind: 'other'; runs: number }

export type RunRow = {
  jobId: string
  ownerId: string
  activityId: number
  activityName: string
  // The station or structure the job ran in (station_id, else facility_id).
  locationId: string | null
  made: Made
  start: string
  end: string
  status: string
  // Whether the run counts toward the totals: a cancelled or reverted job
  // made nothing.
  counted: boolean
  // The run's EIV, for a manufacturing or reaction job the pricing could
  // price; null otherwise.
  eiv: number | null
}

export type HistoryTotals = {
  runs: number
  // EIV over every counted manufacturing/reaction run the pricing priced,
  // and how many such runs it could not.
  eivProduced: number
  pricedRuns: number
  unpricedRuns: number
  // Copies made (one per copy-job run) and the licensed runs they carried.
  copies: number
  licensedRuns: number
  inventionAttempts: number
  inventionSuccesses: number
  researchLevels: number
}

export type HistoryPricing = {
  // blueprint type id → ME0 bill (sde_blueprint_product).
  bills: Readonly<Record<number, Bill>>
  // blueprint type id → what one run produces.
  products: Readonly<Record<number, { productTypeID: number; productQuantity: number }>>
  // A type's adjusted price at a moment (the run's install), or null when
  // unpriced.
  priceAt: (typeId: number, atIso: string) => number | null
}

const UNCOUNTED = new Set(['cancelled', 'reverted'])

const num = (v: number | string | null | undefined): number | null => {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// A job listed by both views (a corp job one of our characters installed)
// counts once, for the corporation: its output is the corp's.
export const dedupeJobs = (characterJobs: HistoryJob[], corpJobs: HistoryJob[]): HistoryJob[] => {
  const corpIds = new Set(corpJobs.map((j) => String(j.job_id)))
  return [...corpJobs, ...characterJobs.filter((j) => !corpIds.has(String(j.job_id)))]
}

const madeBy = (job: HistoryJob, pricing: HistoryPricing): Made => {
  const activity = Number(job.activity_id)
  const runs = num(job.runs) ?? 0
  const blueprintTypeId = Number(job.blueprint_type_id)
  switch (activity) {
    case ACTIVITY.manufacturing:
    case ACTIVITY.reaction: {
      const product = pricing.products[blueprintTypeId]
      const typeId = num(job.product_type_id) ?? product?.productTypeID ?? null
      return typeId == null
        ? { kind: 'other', runs }
        : { kind: 'units', typeId, quantity: runs * (product?.productQuantity ?? 1) }
    }
    case ACTIVITY.copying:
      return { kind: 'copies', typeId: blueprintTypeId, copies: runs, licensedRuns: num(job.licensed_runs) }
    case ACTIVITY.invention:
      return { kind: 'invented', typeId: num(job.product_type_id), successes: num(job.successful_runs), attempts: runs }
    case ACTIVITY.meResearch:
    case ACTIVITY.teResearch:
      return { kind: 'research', levels: runs }
    default:
      return { kind: 'other', runs }
  }
}

// EIV of one run: the ME0 bill priced at the install, scaled by runs. Any
// unpriced material refuses the whole run rather than under-pricing it —
// the posture src/app/structure/eiv.ts takes.
const runEiv = (job: HistoryJob, pricing: HistoryPricing): number | null => {
  if (!isPriceable(job)) return null
  const bill = pricing.bills[Number(job.blueprint_type_id)]
  const runs = num(job.runs)
  if (bill == null || runs == null || runs <= 0) return null
  let sum = 0
  for (const { typeID, quantity } of bill) {
    const price = pricing.priceAt(typeID, job.start_date)
    if (price == null || !Number.isFinite(price)) return null
    sum += quantity * price
  }
  return sum * runs
}

const toRow = (job: HistoryJob, pricing: HistoryPricing): RunRow => {
  const activityId = Number(job.activity_id)
  const location = job.station_id ?? job.facility_id
  return {
    jobId: String(job.job_id),
    ownerId: job.owner_id,
    activityId,
    activityName: ACTIVITY_NAMES[activityId] ?? `Activity ${activityId}`,
    locationId: location == null ? null : String(location),
    made: madeBy(job, pricing),
    start: job.start_date,
    end: job.end_date,
    status: job.status,
    counted: !UNCOUNTED.has(job.status),
    eiv: runEiv(job, pricing),
  }
}

const EMPTY_TOTALS: HistoryTotals = {
  runs: 0,
  eivProduced: 0,
  pricedRuns: 0,
  unpricedRuns: 0,
  copies: 0,
  licensedRuns: 0,
  inventionAttempts: 0,
  inventionSuccesses: 0,
  researchLevels: 0,
}

const addRow = (t: HistoryTotals, row: RunRow): HistoryTotals => {
  if (!row.counted) return t
  const next = { ...t, runs: t.runs + 1 }
  switch (row.made.kind) {
    case 'units':
      return row.eiv == null
        ? { ...next, unpricedRuns: t.unpricedRuns + 1 }
        : { ...next, eivProduced: t.eivProduced + row.eiv, pricedRuns: t.pricedRuns + 1 }
    case 'copies':
      return {
        ...next,
        copies: t.copies + row.made.copies,
        licensedRuns: t.licensedRuns + row.made.copies * (row.made.licensedRuns ?? 0),
      }
    case 'invented':
      return {
        ...next,
        inventionAttempts: t.inventionAttempts + row.made.attempts,
        inventionSuccesses: t.inventionSuccesses + (row.made.successes ?? 0),
      }
    case 'research':
      return { ...next, researchLevels: t.researchLevels + row.made.levels }
    default:
      return next
  }
}

// The page: every run newest first, and the totals over the counted ones.
export const foldHistory = (jobs: HistoryJob[], pricing: HistoryPricing): { rows: RunRow[]; totals: HistoryTotals } => {
  const rows = jobs
    .map((j) => toRow(j, pricing))
    .sort((a, b) => Date.parse(b.start) - Date.parse(a.start) || a.jobId.localeCompare(b.jobId))
  return { rows, totals: rows.reduce(addRow, EMPTY_TOTALS) }
}
