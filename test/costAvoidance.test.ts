// The fold behind the "Cost avoidance" figure on /structure: facility tax never
// incurred because a job ran in a structure we own rather than one we rent.
//
// The thing worth pinning is the derivation. ESI's job `cost` is the wrong base
// (installation fee plus a tax levied on the job's Estimated Item Value, which
// nothing here can compute), so the figure is scaled off the tax receipt
// instead: the journal amount is eiv * own_rate, so avoided is that amount
// times (public_rate / own_rate - 1). At 0.1% against 1% that is nine times
// what we billed ourselves.
import assert from 'node:assert/strict'
import test from 'node:test'

import { costAvoidance } from '../src/app/structure/costAvoidance.ts'

const RATES = { own: 0.001, public: 0.01 }

test('a receipt is scaled by the ratio of the two rates, less what we already billed', () => {
  const result = costAvoidance([{ structureId: 'S1', amount: 1_000_000 }], RATES)
  assert.equal(result.total, 9_000_000)
  assert.equal(result.billed, 1_000_000)
  assert.equal(result.counterfactual, 10_000_000)
  assert.equal(result.jobs, 1)
})

test('the breakdown splits by structure, largest first', () => {
  const result = costAvoidance(
    [
      { structureId: 'small', amount: 1_000 },
      { structureId: 'big', amount: 5_000 },
      { structureId: 'small', amount: 1_000 },
    ],
    RATES
  )
  assert.deepEqual(result.byStructure, [
    ['big', 45_000],
    ['small', 18_000],
  ])
  assert.equal(result.total, 63_000)
})

test('equal rates avoid nothing', () => {
  const result = costAvoidance([{ structureId: 'S1', amount: 1_000_000 }], { own: 0.01, public: 0.01 })
  assert.equal(result.total, 0)
})

test('a public rate declared below your own reports the loss rather than clamping to zero', () => {
  const result = costAvoidance([{ structureId: 'S1', amount: 1_000_000 }], { own: 0.02, public: 0.01 })
  assert.equal(result.total, -500_000)
})

test('a zero own rate makes the saving unknowable rather than infinite', () => {
  const result = costAvoidance([{ structureId: 'S1', amount: 0 }], { own: 0, public: 0.01 })
  assert.equal(result.total, null)
  assert.equal(result.counterfactual, null)
  assert.deepEqual(result.byStructure, [])
  assert.equal(result.jobs, 1)
})

test('no receipts is zero, not an empty-array crash', () => {
  const result = costAvoidance([], RATES)
  assert.deepEqual(result, { total: 0, byStructure: [], billed: 0, counterfactual: 0, jobs: 0 })
})
