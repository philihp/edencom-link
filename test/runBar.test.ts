import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { RUN_BAR_MAX_MS, RUN_BAR_MIN_MS, runBarFraction, runBarGap } from '../src/app/jobs/runBar.ts'

const HOUR = 60 * 60_000
const close = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≉ ${expected}`)

describe('runBarFraction', () => {
  it('gives 0 at the minimum and 1 at the maximum', () => {
    assert.equal(runBarFraction(RUN_BAR_MIN_MS), 0)
    assert.equal(runBarFraction(RUN_BAR_MAX_MS), 1)
  })

  it('clamps a gap outside the range', () => {
    assert.equal(runBarFraction(0), 0)
    assert.equal(runBarFraction(-HOUR), 0)
    assert.equal(runBarFraction(30 * 24 * HOUR), 1)
  })

  it('gives 0 for a gap that is not a finite number', () => {
    assert.equal(runBarFraction(Number.NaN), 0)
    assert.equal(runBarFraction(Number.POSITIVE_INFINITY), 0)
  })

  it('puts the geometric mean of the range at the middle', () => {
    close(runBarFraction(Math.sqrt(RUN_BAR_MIN_MS * RUN_BAR_MAX_MS)), 0.5)
  })

  it('gives equal steps for equal ratios', () => {
    const step = runBarFraction(2 * HOUR) - runBarFraction(HOUR)
    close(runBarFraction(4 * HOUR) - runBarFraction(2 * HOUR), step)
  })

  it('increases with the gap', () => {
    const fractions = [RUN_BAR_MIN_MS, 5 * 60_000, HOUR, 6 * HOUR, 24 * HOUR, RUN_BAR_MAX_MS].map(runBarFraction)
    fractions.slice(1).forEach((f, i) => assert.ok(f > fractions[i]))
  })
})

describe('runBarGap', () => {
  it('measures time since a past run', () => {
    assert.equal(runBarGap('since', 1_000, 5_000), 4_000)
  })

  it('measures time until a future run', () => {
    assert.equal(runBarGap('until', 5_000, 1_000), 4_000)
  })
})
