// The /asset value chart's own window options. A hangar's worth moves slowly
// and the record runs back years, so this one chart drops the 1- and 3-day
// spans the other pages offer (timeWindow.ts) and adds 1, 2 and 30 years.
// The 30-year span reads as "everything on record".
//
// Pure: no I/O.
import { type TimeWindowOption } from '../timeWindow.ts'

const YEAR_DAYS = 365

const days = (n: number): TimeWindowOption => ({ label: `${n} days`, days: n })
const years = (n: number): TimeWindowOption => ({ label: n === 1 ? '1 year' : `${n} years`, days: n * YEAR_DAYS })

export const ASSET_WINDOW_OPTIONS: readonly TimeWindowOption[] = [
  days(7),
  days(14),
  days(30),
  days(90),
  years(1),
  years(2),
  years(30),
]

export const DEFAULT_ASSET_WINDOW_DAYS = 30

export const isAssetWindowDays = (n: unknown): n is number =>
  typeof n === 'number' && ASSET_WINDOW_OPTIONS.some((o) => o.days === n)

// The longest span the page offers: how far back the page reads stored rows.
export const LONGEST_ASSET_WINDOW_DAYS = Math.max(...ASSET_WINDOW_OPTIONS.map((o) => o.days))

// Past a quarter, day ticks ("27 Nov") lose the year; label months instead.
export const monthlyTicks = (windowDays: number): boolean => windowDays > 90
