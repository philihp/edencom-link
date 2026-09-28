// Unit coverage for the start delay of the scheduled per-character refreshes
// (src/workflows/staggerDelay.ts). The delay is invisible when it is wrong — a
// refresh an hour late still looks like a refresh — so these tests pin the
// three properties the stagger is for: it stays inside the hour, one character's
// jobs start at the same second whichever minute their cron fires, and
// different characters start at different seconds.
import assert from 'node:assert/strict'
import test from 'node:test'

import { STAGGER_WINDOW_SECONDS, staggerDelaySeconds, staggeredStartMs } from '../src/workflows/staggerDelay.ts'

const ALICE = '00000000-0000-0000-0000-000000000e10' // 0xe10 = 3600 → second 0
const BOB = '00000000-0000-0000-0000-00000000012c' // 0x12c = 300 → second 300
const REAL = '3f2a9c1e-7b4d-4e8a-9f10-2c3d4e5f6a7b'

test('the delay is the time until the character’s second of the hour', () => {
  assert.equal(staggerDelaySeconds(BOB, 0), 300)
  assert.equal(staggerDelaySeconds(BOB, 100), 200)
  assert.equal(staggerDelaySeconds(BOB, 300), 0)
  assert.equal(staggerDelaySeconds(BOB, 301), 3599)
  assert.equal(staggerDelaySeconds(ALICE, 7200), 0)
  assert.equal(staggerDelaySeconds(ALICE, 7201), 3599)
})

test('the delay is always in [0, 3600)', () => {
  const nows = [0, 1, 59, 1_790_000_000, 1_790_003_599, 1_790_003_600]
  const delays = nows.flatMap((now) => [ALICE, BOB, REAL].map((id) => staggerDelaySeconds(id, now)))
  assert.ok(delays.every((d) => Number.isInteger(d) && d >= 0 && d < STAGGER_WINDOW_SECONDS))
})

test('one character’s jobs start at the same second of the hour, whatever minute each cron fires', () => {
  // The 6h crons fire at :14, :24, :26, :28, :34, :44, :46, :48 of one hour. A
  // job that fires after the character's second waits for it in the next hour,
  // so the start is the same second of the hour, not always the same hour.
  const hour = Date.UTC(2026, 8, 28, 12) / 1000
  const starts = [14, 24, 26, 28, 34, 44, 46, 48].map((minute) => {
    const now = hour + minute * 60
    return (now + staggerDelaySeconds(REAL, now)) % STAGGER_WINDOW_SECONDS
  })
  assert.equal(new Set(starts).size, 1)
})

test('different characters start at different seconds of the hour', () => {
  const nowMs = Date.UTC(2026, 8, 28, 12, 24)
  const startOf = staggeredStartMs(nowMs)
  assert.equal(startOf(BOB) - nowMs, ((300 - 24 * 60 + 3600) % 3600) * 1000)
  assert.notEqual(startOf(ALICE), startOf(BOB))
})

test('the start never comes before the fire time and never an hour after it', () => {
  const nowMs = Date.UTC(2026, 8, 28, 12, 24, 17, 500)
  const startOf = staggeredStartMs(nowMs)
  const offsets = [ALICE, BOB, REAL].map((id) => startOf(id) - nowMs)
  assert.ok(offsets.every((o) => o >= 0 && o < STAGGER_WINDOW_SECONDS * 1000))
})
