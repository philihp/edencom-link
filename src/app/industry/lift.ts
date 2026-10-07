// Lift: what an industry job is worth, and the rate at which the hangar as a
// whole is earning it (docs/design-system/Industry.dc.html).
//
// A job's lift is the Jita-split value of what it makes, minus the Jita-split
// value of what it consumes, minus the fee ESI billed to install it — every
// price taken at the moment the job was installed, never today's. Spread
// evenly over the job's duration it is an ISK/hr rate, and summing the rates
// of every job running at an instant gives the hangar's lift rate at that
// instant. That sum is a step function — it jumps when a job installs and
// drops when one ends — and is drawn as one, because that is what the data is.
//
// Only manufacturing and reactions are measured: research, copying and
// invention make nothing the market prices directly, so they are listed but
// inert (lift null). Idle slots are not counted — this is lift from jobs, not
// utilisation.
//
// Pure: no I/O, no Date.now(). The page feeds it rows, prices and `now`.
import { find, reduce, sortBy } from 'ramda'

export type LiftFamily = 'manufacturing' | 'reaction' | 'research'

// ESI job activity ids (src/app/industry/jobFields.ts): manufacturing 1,
// reactions 9; every science activity (3, 4, 5, 7, 8) is research here.
export const liftFamily = (activityId: number): LiftFamily =>
  activityId === 1 ? 'manufacturing' : activityId === 9 ? 'reaction' : 'research'

// The Jita split: the midpoint of best bid and best ask. A one-sided book
// prices at the side it has; an empty one prices at nothing.
export const splitPrice = (buy: number | null | undefined, sell: number | null | undefined): number | null => {
  const b = buy != null && Number.isFinite(buy) ? buy : null
  const s = sell != null && Number.isFinite(sell) ? sell : null
  if (b == null && s == null) return null
  if (b == null) return s
  if (s == null) return b
  return (b + s) / 2
}

// What a job actually consumes of one material: the game's own rounding —
// `max(runs, ceil(round(runs × base × (1 − ME), 2)))` — so a 1-per-run input
// never drops below one per run however good the blueprint. Structure and rig
// bonuses are not applied: the extract records neither where the ME rig was
// nor whether it covered the product, and guessing them would flatter every
// job by a few percent. ME comes from the blueprint row when we hold it, else 0.
export const materialQuantity = (base: number, runs: number, me: number): number =>
  Math.max(runs, Math.ceil(Math.round(runs * base * (1 - me / 100) * 100) / 100))

export type PricedLine = { quantity: number; price: number | null }

export type LiftInput = {
  runs: number
  // The install fee ESI billed (`cost`); null when ESI never reported one.
  cost: number | null
  // Per-run product quantity and its split price at install.
  product: PricedLine
  // Per-run base quantities (ME0) and their split prices at install.
  materials: readonly PricedLine[]
  me: number
}

// The lift of one job, or null when any line is unpriced: a bill with one
// unknown material cannot be totalled, and a wrong total is worse than none.
export const jobLift = ({ runs, cost, product, materials, me }: LiftInput): number | null => {
  if (!Number.isFinite(runs) || runs <= 0) return null
  if (product.price == null) return null
  const inputs = reduce(
    (sum: number | null, { quantity, price }: PricedLine) =>
      sum == null || price == null ? null : sum + materialQuantity(quantity, runs, me) * price,
    0 as number | null,
    materials
  )
  return inputs == null ? null : runs * product.quantity * product.price - inputs - (cost ?? 0)
}

const HOUR = 3_600_000

// A job as the chart and list see it: instants in epoch ms, lift and rate
// already settled (null for research or an unpriced bill).
export type LiftJob = {
  id: string
  ownerId: string
  family: LiftFamily
  activityId: number
  productTypeId: number | null
  blueprintTypeId: number
  runs: number
  status: string
  start: number
  end: number
  stationId: string | null
  lift: number | null
  // ISK per hour, lift spread evenly over the job's duration.
  rate: number | null
}

export const liftRate = (lift: number | null, start: number, end: number): number | null => {
  if (lift == null) return null
  const hours = (end - start) / HOUR
  return hours > 0 ? lift / hours : null
}

// A job that never produced (cancelled or reverted) earned nothing and never
// counted toward the rate at any instant.
export const producedNothing = (status: string): boolean => status === 'cancelled' || status === 'reverted'

// Open in the game's sense: not yet delivered, whatever the clock says.
export const OPEN_STATUSES: ReadonlySet<string> = new Set(['active', 'paused', 'ready'])

export type LiftScope = 'all' | 'manufacturing' | 'reaction'

// Whether a job contributes to the rate under a scope. `all` is every job
// with a measurable lift — which excludes research by construction.
export const inScope = (job: LiftJob, scope: LiftScope): boolean =>
  job.rate != null && !producedNothing(job.status) && (scope === 'all' || job.family === scope)

// The jobs running at an instant (start ≤ t < end), biggest earner first.
export const runningAt = (jobs: readonly LiftJob[], t: number, scope: LiftScope): LiftJob[] =>
  sortBy(
    (j) => -(j.rate ?? 0),
    jobs.filter((j) => inScope(j, scope) && j.start <= t && j.end > t)
  )

export type RateSegment = { a: number; b: number; v: number }

// The step function over [t0, t1]: one segment per stretch of time during
// which the running set does not change, carrying the summed rate. A sweep
// over the sorted install/end events, so a thousand jobs cost a sort rather
// than a thousand scans; a job already running at t0 is counted in the
// opening sum, and a job ending exactly at t0 is not.
export const rateSegments = (jobs: readonly LiftJob[], t0: number, t1: number, scope: LiftScope): RateSegment[] => {
  if (!(t1 > t0)) return []
  // The opening sum and the install/end events inside the window. Push-
  // mutated accumulators, by the house rule for large folds.
  const { opening, events } = reduce(
    (acc: { opening: number; events: Array<{ t: number; delta: number }> }, job: LiftJob) => {
      if (!inScope(job, scope) || job.rate == null) return acc
      if (job.end <= t0 || job.start >= t1) return acc
      if (job.start <= t0) acc.opening += job.rate
      else acc.events.push({ t: job.start, delta: job.rate })
      if (job.end < t1) acc.events.push({ t: job.end, delta: -job.rate })
      return acc
    },
    { opening: 0, events: [] },
    jobs
  )
  // The sweep: each event closes the segment running up to it and changes the
  // sum; the last segment runs to the window's end.
  const swept = reduce(
    (acc: { at: number; value: number; segments: RateSegment[] }, { t, delta }: { t: number; delta: number }) => {
      if (t > acc.at) acc.segments.push({ a: acc.at, b: t, v: acc.value })
      return { at: t, value: acc.value + delta, segments: acc.segments }
    },
    { at: t0, value: opening, segments: [] },
    sortBy((e) => e.t, events)
  )
  if (t1 > swept.at) swept.segments.push({ a: swept.at, b: t1, v: swept.value })
  return swept.segments
}

export type RateSummary = { median: number; average: number; total: number }

// The window's summary, read off the step function itself so it agrees with
// what is drawn: `total` is the ISK lifted across the window (the area under
// the steps), `average` that total over the window's hours, and `median` the
// rate the line sat at or below for half the window's time — time-weighted,
// so an idle stretch counts as zero for as long as it lasted. Null for an
// empty window.
export const summarizeRate = (segments: readonly RateSegment[]): RateSummary | null => {
  const span = segments.reduce((sum, s) => sum + (s.b - s.a), 0)
  if (!(span > 0)) return null
  const total = segments.reduce((sum, s) => sum + (s.v * (s.b - s.a)) / HOUR, 0)
  // The rate at which half the window's time has been reached, walking the
  // segments from the lowest rate up.
  const byRate = sortBy((s) => s.v, segments)
  const half = span / 2
  const { median } = reduce(
    (acc: { seen: number; median: number | null }, s: RateSegment) =>
      acc.median != null
        ? acc
        : acc.seen + (s.b - s.a) >= half
          ? { seen: acc.seen, median: s.v }
          : { seen: acc.seen + (s.b - s.a), median: null },
    { seen: 0, median: null },
    byRate
  )
  return { median: median ?? byRate[byRate.length - 1].v, average: (total * HOUR) / span, total }
}

// The jobs that overlap a window at all, for the "n jobs in view" readout.
export const jobsInView = (jobs: readonly LiftJob[], t0: number, t1: number, scope: LiftScope): LiftJob[] =>
  jobs.filter((j) => inScope(j, scope) && j.end > t0 && j.start < t1)

// The job list under the chart when a window is shown: every job that ran at
// any point in it, whatever its family or whether its bill priced — research
// is listed, just unmeasured, the same rule the active list always had. Open
// jobs first, soonest to finish at the top; then the finished ones, most
// recently ended first.
export const jobsListedInWindow = (jobs: readonly LiftJob[], t0: number, t1: number): LiftJob[] => {
  const overlapping = jobs.filter((j) => j.end > t0 && j.start < t1)
  const open = sortBy(
    (j) => j.end,
    overlapping.filter((j) => OPEN_STATUSES.has(j.status))
  )
  const done = sortBy(
    (j) => -j.end,
    overlapping.filter((j) => !OPEN_STATUSES.has(j.status))
  )
  return [...open, ...done]
}

// A y-axis ceiling that reads as a round number: the smallest 1/2/5 × 10^k at
// or above the peak, never below one million so an idle week still has a
// scale. Zero or a negative peak (a window of losses) sits on the floor.
export const niceCeiling = (peak: number): number => {
  const floor = 1_000_000
  if (!(peak > floor)) return floor
  const magnitude = 10 ** Math.floor(Math.log10(peak))
  return (find((step) => step * magnitude >= peak, [1, 2, 5, 10]) ?? 10) * magnitude
}

// ISK the way the design's readouts spell it: 1.23B, 45.6M, 789k — a sign
// kept for a loss, and a dash for nothing to say.
export const formatCompactIsk = (value: number | null | undefined): string => {
  if (value == null || !Number.isFinite(value)) return '—'
  const sign = value < 0 ? '−' : ''
  const v = Math.abs(value)
  if (v >= 1e9) return `${sign}${(v / 1e9).toFixed(2)}B`
  if (v >= 1e6) return `${sign}${(v / 1e6).toFixed(1)}M`
  return `${sign}${(v / 1e3).toFixed(0)}k`
}

// A job's progress at an instant, as the scoped list reports it: 0–100,
// clamped, so a job that ended before the moment reads 100 and one installed
// after it reads 0 (it would not be listed; the clamp is a safety).
export const progressAt = (job: Pick<LiftJob, 'start' | 'end'>, t: number): number =>
  job.end > job.start ? Math.round(100 * Math.min(1, Math.max(0, (t - job.start) / (job.end - job.start)))) : 100

// "2d 4h" / "3h 12m" / "ready" — time left on a job, as the active list shows.
export const formatRemaining = (end: number, now: number): string => {
  const ms = end - now
  if (ms <= 0) return 'ready'
  const totalMinutes = Math.floor(ms / 60_000)
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}
