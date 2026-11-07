// Bar length for the "Last run" and "Next run" cells on /account/registrations.
//
// A cell shows a gap of time: the time since the last run, or the time to the
// next run. The bar length is the fraction of that gap on a logarithmic scale
// between RUN_BAR_MIN_MS and RUN_BAR_MAX_MS. A gap at or below the minimum
// gives 0. A gap at or above the maximum gives 1. A log scale keeps a gap of
// minutes and a gap of days both legible in one column.

import { clamp, divide, flip, pipe, subtract } from 'ramda'

// One minute. A shorter gap shows no bar: "due now" and "just ran" look empty.
export const RUN_BAR_MIN_MS = 60_000

// Seven days. The slowest schedule (sde-moons) is weekly, so a gap this long
// already means the job is very late or does not run on a schedule.
export const RUN_BAR_MAX_MS = 7 * 24 * 60 * 60_000

const LOG_MIN = Math.log(RUN_BAR_MIN_MS)
const LOG_SPAN = Math.log(RUN_BAR_MAX_MS) - LOG_MIN

// Gap in milliseconds → fraction in [0, 1]. A gap that is not a finite number
// (a bad date) gives 0.
export const runBarFraction: (gapMs: number) => number = pipe(
  (gapMs: number) => (Number.isFinite(gapMs) ? gapMs : RUN_BAR_MIN_MS),
  clamp(RUN_BAR_MIN_MS, RUN_BAR_MAX_MS),
  Math.log,
  flip(subtract)(LOG_MIN),
  flip(divide)(LOG_SPAN)
)

// The gap a cell shows. "since" is the time from `at` to `now` (last run).
// "until" is the time from `now` to `at` (next run).
export type RunBarSide = 'since' | 'until'

export const runBarGap = (side: RunBarSide, at: number, now: number): number => (side === 'since' ? now - at : at - now)
