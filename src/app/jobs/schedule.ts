// Cron arithmetic for the /jobs page's "Next run" column (docs/jobs-page.md).
//
// Vercel evaluates the `crons` entries in vercel.json in **UTC**, so everything
// here does too — no local-time conversion anywhere, and the caller formats for
// display. Pure and dependency-light on purpose: this is the one piece of the
// page with real logic to get wrong, so it's unit-tested (test/schedule.test.ts)
// rather than left to `next build`.
//
// Only the 5-field syntax Vercel accepts is supported: minute, hour,
// day-of-month, month, day-of-week — with `*`, `a`, `a-b`, `*/n`, `a-b/n`, and
// comma-separated lists of those. No names (`MON`, `JAN`), no `@daily`, no `L`/
// `W`/`#` extensions; none appear in vercel.json and an unparseable expression
// returns null rather than guessing.

import { all, filter, find, findLast, head, last, map, range as rRange, sortBy, uniq } from 'ramda'

export type CronFields = {
  minutes: number[]
  hours: number[]
  daysOfMonth: number[]
  months: number[]
  daysOfWeek: number[]
  // Standard cron's oddest rule: when *both* day-of-month and day-of-week are
  // restricted, a day matches if it satisfies *either* (not both). Knowing which
  // fields were literally `*` is the only way to apply it, so parsing records it.
  domRestricted: boolean
  dowRestricted: boolean
}

const MINUTE_MS = 60_000
const DAY_MS = 86_400_000

// A year of days is the most any valid 5-field expression can need before it
// matches (Feb 29 on a non-matching month being the pathological case), so this
// bounds the search rather than looping forever on something like `0 0 30 2 *`.
const MAX_DAYS = 366

const NUMBER = /^\d+$/

// One comma-separated term of a field: `*`, `7`, `9-17`, `*/6`, `9-17/2`.
const parseTerm = (term: string, min: number, max: number): number[] | null => {
  const parts = term.split('/')
  if (parts.length > 2) return null
  const [spec, stepText] = parts
  if (stepText !== undefined && !NUMBER.test(stepText)) return null
  const step = stepText === undefined ? 1 : Number(stepText)
  if (step < 1) return null

  const bounds = spec === '*' ? [min, max] : spec.split('-')
  if (spec !== '*') {
    if (bounds.length > 2 || !all((p) => NUMBER.test(p as string), bounds as string[])) return null
  }
  const [lo, hi] =
    spec === '*'
      ? [min, max]
      : bounds.length === 1
        ? [Number(bounds[0]), Number(bounds[0])]
        : [Number(bounds[0]), Number(bounds[1])]
  if (lo < min || hi > max || lo > hi) return null

  return filter((n) => (n - lo) % step === 0, rRange(lo, hi + 1))
}

const parseField = (field: string, min: number, max: number): number[] | null => {
  const terms = map((t) => parseTerm(t, min, max), field.split(','))
  if (terms.some((t) => t === null)) return null
  return sortBy((n) => n, uniq(terms.flat() as number[]))
}

// Parse a 5-field UTC cron expression, or null if it isn't one.
export const parseCron = (expression: string): CronFields | null => {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const [minute, hour, dom, month, dow] = fields

  const minutes = parseField(minute, 0, 59)
  const hours = parseField(hour, 0, 23)
  const daysOfMonth = parseField(dom, 1, 31)
  const months = parseField(month, 1, 12)
  // 7 is a second spelling of Sunday, so parse 0-7 and fold it onto 0.
  const dowRaw = parseField(dow, 0, 7)
  if (!minutes || !hours || !daysOfMonth || !months || !dowRaw) return null
  const daysOfWeek = sortBy((n) => n, uniq(map((d) => d % 7, dowRaw)))

  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    domRestricted: dom !== '*',
    dowRestricted: dow !== '*',
  }
}

const dayMatches = (fields: CronFields, day: Date): boolean => {
  if (!fields.months.includes(day.getUTCMonth() + 1)) return false
  const domHit = fields.daysOfMonth.includes(day.getUTCDate())
  const dowHit = fields.daysOfWeek.includes(day.getUTCDay())
  if (fields.domRestricted && fields.dowRestricted) return domHit || dowHit
  if (fields.domRestricted) return domHit
  if (fields.dowRestricted) return dowHit
  return true
}

const atUtc = (day: Date, hour: number, minute: number) =>
  new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, minute))

// Earliest (hour, minute) on a matching day at or after the floor, or null when
// the day has no slot left. Minutes are sorted, so "some minute qualifies in
// this hour" is just a check against the last one.
const firstSlot = (fields: CronFields, floorHour: number, floorMinute: number): [number, number] | null => {
  const hour = find(
    (h) => h > floorHour || (h === floorHour && (last(fields.minutes) as number) >= floorMinute),
    fields.hours
  )
  if (hour === undefined) return null
  const minute = hour === floorHour ? find((m) => m >= floorMinute, fields.minutes) : head(fields.minutes)
  return minute === undefined ? null : [hour, minute]
}

// The mirror of firstSlot: latest (hour, minute) at or before the ceiling.
const lastSlot = (fields: CronFields, ceilHour: number, ceilMinute: number): [number, number] | null => {
  const hour = findLast(
    (h) => h < ceilHour || (h === ceilHour && (head(fields.minutes) as number) <= ceilMinute),
    fields.hours
  )
  if (hour === undefined) return null
  const minute = hour === ceilHour ? findLast((m) => m <= ceilMinute, fields.minutes) : last(fields.minutes)
  return minute === undefined ? null : [hour, minute]
}

// Walk forward a day at a time (never minute by minute — 366 frames instead of
// half a million), carrying the intra-day floor only for the first day. Tail
// recursive per the house style; the depth cap is MAX_DAYS.
const scanForward = (
  fields: CronFields,
  day: Date,
  floorHour: number,
  floorMinute: number,
  left: number
): Date | null => {
  if (left <= 0) return null
  if (dayMatches(fields, day)) {
    const slot = firstSlot(fields, floorHour, floorMinute)
    if (slot) return atUtc(day, slot[0], slot[1])
  }
  return scanForward(fields, new Date(day.getTime() + DAY_MS), 0, 0, left - 1)
}

const scanBackward = (
  fields: CronFields,
  day: Date,
  ceilHour: number,
  ceilMinute: number,
  left: number
): Date | null => {
  if (left <= 0) return null
  if (dayMatches(fields, day)) {
    const slot = lastSlot(fields, ceilHour, ceilMinute)
    if (slot) return atUtc(day, slot[0], slot[1])
  }
  return scanBackward(fields, new Date(day.getTime() - DAY_MS), 23, 59, left - 1)
}

const utcMidnight = (at: Date) => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()))

// The next time `expression` fires, strictly after `from` (a fire happening in
// the current minute counts as past — cron's own semantics, and the half-minute
// of skew that costs never shows up in a "in 3h 26m" countdown). Null when the
// expression doesn't parse or matches no day within a year.
export const nextCronRun = (expression: string, from: Date = new Date()): Date | null => {
  const fields = parseCron(expression)
  if (!fields) return null
  const floor = new Date(Math.floor(from.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS)
  return scanForward(fields, utcMidnight(floor), floor.getUTCHours(), floor.getUTCMinutes(), MAX_DAYS)
}

// The most recent time `expression` fired at or before `from`. This is what
// makes "overdue" detectable: a job whose last heartbeat predates its previous
// scheduled fire didn't run when it should have.
export const previousCronRun = (expression: string, from: Date = new Date()): Date | null => {
  const fields = parseCron(expression)
  if (!fields) return null
  const ceil = new Date(Math.floor(from.getTime() / MINUTE_MS) * MINUTE_MS)
  return scanBackward(fields, utcMidnight(ceil), ceil.getUTCHours(), ceil.getUTCMinutes(), MAX_DAYS)
}
