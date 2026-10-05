// Lift: a job's value at install prices, its ISK/hr rate, and the step
// function the hangar's running jobs sum to (src/app/industry/lift.ts).
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  formatCompactIsk,
  formatRemaining,
  jobLift,
  jobsInView,
  liftFamily,
  liftRate,
  materialQuantity,
  niceCeiling,
  progressAt,
  rateSegments,
  runningAt,
  splitPrice,
  summarizeRate,
  type LiftJob,
} from '../src/app/industry/lift.ts'

const HOUR = 3_600_000

const job = (over: Partial<LiftJob> & { id: string; start: number; end: number }): LiftJob => ({
  ownerId: 'o',
  family: 'manufacturing',
  activityId: 1,
  productTypeId: 1,
  blueprintTypeId: 2,
  runs: 1,
  status: 'delivered',
  stationId: null,
  lift: null,
  rate: null,
  ...over,
})

test('the split is the midpoint, or the one side a one-sided book has', () => {
  assert.equal(splitPrice(4, 6), 5)
  assert.equal(splitPrice(null, 6), 6)
  assert.equal(splitPrice(4, null), 4)
  assert.equal(splitPrice(null, null), null)
})

test('material quantity follows the game: round to cents, ceil, never under one per run', () => {
  // 10 runs × 100 base at ME 10 = 900 exactly.
  assert.equal(materialQuantity(100, 10, 10), 900)
  // 1 run × 1 base at ME 10 = 0.9 → ceil → 1; and max(runs, …) holds it there.
  assert.equal(materialQuantity(1, 1, 10), 1)
  // 3 runs × 1 base at ME 10 = 2.7 → 3.
  assert.equal(materialQuantity(1, 3, 10), 3)
  // ME0 is the base bill.
  assert.equal(materialQuantity(7, 4, 0), 28)
  // Floating point: 1 × 3 × 0.9 = 2.7000000000000006 would ceil to 3 either
  // way, but 12 × 0.1 × 0.9 style products need the cent rounding first.
  assert.equal(materialQuantity(0.1 * 3, 1, 0), 1)
})

test('lift is output value minus input bill minus the install fee', () => {
  const lift = jobLift({
    runs: 10,
    cost: 1_000,
    product: { quantity: 2, price: 500 }, // 10 × 2 × 500 = 10,000
    materials: [
      { quantity: 10, price: 30 }, // 100 × 30 = 3,000
      { quantity: 1, price: 100 }, // 10 × 100 = 1,000
    ],
    me: 0,
  })
  assert.equal(lift, 10_000 - 3_000 - 1_000 - 1_000)
})

test('an unpriced line refuses the whole job rather than under-counting it', () => {
  const base = { runs: 1, cost: 0, product: { quantity: 1, price: 100 }, me: 0 }
  assert.equal(jobLift({ ...base, materials: [{ quantity: 1, price: null }] }), null)
  assert.equal(jobLift({ ...base, product: { quantity: 1, price: null }, materials: [] }), null)
  assert.equal(jobLift({ ...base, runs: 0, materials: [] }), null)
  // A missing fee is a fee of nothing, not an unpriced job.
  assert.equal(jobLift({ ...base, cost: null, materials: [] }), 100)
})

test('rate spreads the lift over the duration', () => {
  assert.equal(liftRate(240, 0, 2 * HOUR), 120)
  assert.equal(liftRate(null, 0, HOUR), null)
  assert.equal(liftRate(100, HOUR, HOUR), null)
})

test('activity ids fold into the three families', () => {
  assert.equal(liftFamily(1), 'manufacturing')
  assert.equal(liftFamily(9), 'reaction')
  for (const id of [3, 4, 5, 7, 8]) assert.equal(liftFamily(id), 'research')
})

// Two jobs: A runs 0h–4h at 10/hr, B runs 2h–6h at 5/hr.
const A = job({ id: 'A', start: 0, end: 4 * HOUR, lift: 40, rate: 10 })
const B = job({ id: 'B', start: 2 * HOUR, end: 6 * HOUR, lift: 20, rate: 5, family: 'reaction', activityId: 9 })

test('the step function jumps at installs and drops at ends', () => {
  assert.deepEqual(rateSegments([A, B], 0, 8 * HOUR, 'all'), [
    { a: 0, b: 2 * HOUR, v: 10 },
    { a: 2 * HOUR, b: 4 * HOUR, v: 15 },
    { a: 4 * HOUR, b: 6 * HOUR, v: 5 },
    { a: 6 * HOUR, b: 8 * HOUR, v: 0 },
  ])
})

test('the window summary is read off the steps, time-weighted', () => {
  // 10/hr for 2h, 15 for 2h, 5 for 2h, idle for 2h: 60 ISK over 8 hours, and
  // the line sat at 5 or below for exactly half of them.
  assert.deepEqual(summarizeRate(rateSegments([A, B], 0, 8 * HOUR, 'all')), { median: 5, average: 7.5, total: 60 })
  // A long stretch at one rate outweighs several short spikes.
  assert.deepEqual(
    summarizeRate([
      { a: 0, b: HOUR, v: 100 },
      { a: HOUR, b: 9 * HOUR, v: 2 },
      { a: 9 * HOUR, b: 10 * HOUR, v: 50 },
    ]),
    { median: 2, average: 16.6, total: 166 }
  )
  assert.equal(summarizeRate([]), null)
})

test('a window opening mid-job counts it from the first instant', () => {
  assert.deepEqual(rateSegments([A, B], 3 * HOUR, 5 * HOUR, 'all'), [
    { a: 3 * HOUR, b: 4 * HOUR, v: 15 },
    { a: 4 * HOUR, b: 5 * HOUR, v: 5 },
  ])
  // A job ending exactly at the window's open never counts; one starting
  // exactly at its close never counts either.
  assert.deepEqual(rateSegments([A, B], 4 * HOUR, 4.5 * HOUR, 'all'), [{ a: 4 * HOUR, b: 4.5 * HOUR, v: 5 }])
  assert.deepEqual(rateSegments([A], 4 * HOUR, 5 * HOUR, 'all'), [{ a: 4 * HOUR, b: 5 * HOUR, v: 0 }])
  assert.deepEqual(rateSegments([A], HOUR, HOUR, 'all'), [])
})

test('scope narrows to one family; research and dead jobs never count', () => {
  assert.deepEqual(rateSegments([A, B], 0, 6 * HOUR, 'reaction'), [
    { a: 0, b: 2 * HOUR, v: 0 },
    { a: 2 * HOUR, b: 6 * HOUR, v: 5 },
  ])
  const research = job({ id: 'R', start: 0, end: 6 * HOUR, family: 'research', activityId: 4, lift: null, rate: null })
  const cancelled = job({ id: 'C', start: 0, end: 6 * HOUR, lift: 99, rate: 99, status: 'cancelled' })
  assert.deepEqual(rateSegments([research, cancelled], 0, 6 * HOUR, 'all'), [{ a: 0, b: 6 * HOUR, v: 0 }])
})

test('running at an instant: start inclusive, end exclusive, biggest earner first', () => {
  assert.deepEqual(
    runningAt([A, B], 2 * HOUR, 'all').map((j) => j.id),
    ['A', 'B']
  )
  assert.deepEqual(
    runningAt([A, B], 4 * HOUR, 'all').map((j) => j.id),
    ['B']
  )
  assert.deepEqual(runningAt([A, B], 6 * HOUR, 'all'), [])
  assert.deepEqual(
    runningAt([A, B], 3 * HOUR, 'reaction').map((j) => j.id),
    ['B']
  )
})

test('jobs in view are the ones overlapping the window', () => {
  assert.deepEqual(
    jobsInView([A, B], 5 * HOUR, 9 * HOUR, 'all').map((j) => j.id),
    ['B']
  )
  assert.deepEqual(jobsInView([A, B], 6 * HOUR, 9 * HOUR, 'all'), [])
})

test('the axis ceiling is a round number at or above the peak, never under a million', () => {
  assert.equal(niceCeiling(0), 1_000_000)
  assert.equal(niceCeiling(-5), 1_000_000)
  assert.equal(niceCeiling(1_000_000), 1_000_000)
  assert.equal(niceCeiling(1_200_000), 2_000_000)
  assert.equal(niceCeiling(37_000_000), 50_000_000)
  assert.equal(niceCeiling(50_000_000), 50_000_000)
  assert.equal(niceCeiling(60_000_000), 100_000_000)
  assert.equal(niceCeiling(2.4e9), 5e9)
})

test('compact ISK keeps the design spelling and the sign of a loss', () => {
  assert.equal(formatCompactIsk(1_234_000_000), '1.23B')
  assert.equal(formatCompactIsk(45_600_000), '45.6M')
  assert.equal(formatCompactIsk(789_000), '789k')
  assert.equal(formatCompactIsk(-2_500_000), '−2.5M')
  assert.equal(formatCompactIsk(0), '0k')
  assert.equal(formatCompactIsk(null), '—')
})

test('progress and remaining time read as the list spells them', () => {
  assert.equal(progressAt({ start: 0, end: 4 * HOUR }, 3 * HOUR), 75)
  assert.equal(progressAt({ start: 0, end: 4 * HOUR }, 9 * HOUR), 100)
  assert.equal(progressAt({ start: HOUR, end: HOUR }, HOUR), 100)
  assert.equal(formatRemaining(50 * HOUR, 0), '2d 2h')
  assert.equal(formatRemaining(3 * HOUR + 12 * 60_000, 0), '3h 12m')
  assert.equal(formatRemaining(7 * 60_000, 0), '7m')
  assert.equal(formatRemaining(0, 1), 'ready')
})
