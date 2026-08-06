// Unit coverage for the /jobs page's cron arithmetic (docs/jobs-page.md).
//
// This is the one part of that page with logic that can be quietly wrong: a
// "Next run" that's off by six hours looks perfectly plausible on screen. So
// the assertions pin the three things worth pinning — every cron shape
// vercel.json actually uses, the UTC-not-local rule (Vercel schedules in UTC,
// and a local-time bug would only show up for contributors outside it), and the
// previous-fire direction that makes "overdue" detectable.
import assert from 'node:assert/strict'
import test from 'node:test'

import { nextCronRun, parseCron, previousCronRun } from '../src/app/jobs/schedule.ts'

const at = (iso: string) => new Date(iso)
const iso = (d: Date | null) => (d === null ? null : d.toISOString())

test('parses the field syntax vercel.json uses', () => {
  const everySixHours = parseCron('24 */6 * * *')
  assert.deepEqual(everySixHours?.minutes, [24])
  assert.deepEqual(everySixHours?.hours, [0, 6, 12, 18])
  assert.equal(everySixHours?.domRestricted, false)
  assert.equal(everySixHours?.dowRestricted, false)

  const daily = parseCron('7 9 * * *')
  assert.deepEqual(daily?.minutes, [7])
  assert.deepEqual(daily?.hours, [9])

  // character-mercenary-dens runs hourly (Discord stage 04 detection cadence).
  const hourly = parseCron('30 * * * *')
  assert.deepEqual(hourly?.minutes, [30])
  assert.deepEqual(
    hourly?.hours,
    Array.from({ length: 24 }, (_, h) => h)
  )
})

test('parses ranges, lists and stepped ranges', () => {
  assert.deepEqual(parseCron('0,30 9-17/4 * * *')?.minutes, [0, 30])
  assert.deepEqual(parseCron('0,30 9-17/4 * * *')?.hours, [9, 13, 17])
  assert.deepEqual(parseCron('0 0 * * 1-5')?.daysOfWeek, [1, 2, 3, 4, 5])
  // 7 is a second spelling of Sunday and folds onto 0.
  assert.deepEqual(parseCron('0 0 * * 7')?.daysOfWeek, [0])
})

test('rejects what it cannot honestly evaluate', () => {
  assert.equal(parseCron('* * * *'), null, 'four fields')
  assert.equal(parseCron('0 0 * * * *'), null, 'six fields')
  assert.equal(parseCron('@daily'), null, 'nickname syntax')
  assert.equal(parseCron('0 0 * * MON'), null, 'day names')
  assert.equal(parseCron('60 0 * * *'), null, 'minute out of range')
  assert.equal(parseCron('0 24 * * *'), null, 'hour out of range')
  assert.equal(parseCron('0 17-9 * * *'), null, 'inverted range')
  assert.equal(nextCronRun('nonsense'), null)
  assert.equal(previousCronRun('nonsense'), null)
})

test('finds the next fire within the day, and rolls to the next day', () => {
  // character-orders: 24 past every sixth hour.
  assert.equal(iso(nextCronRun('24 */6 * * *', at('2026-07-26T12:00:00Z'))), '2026-07-26T12:24:00.000Z')
  assert.equal(iso(nextCronRun('24 */6 * * *', at('2026-07-26T12:25:00Z'))), '2026-07-26T18:24:00.000Z')
  assert.equal(iso(nextCronRun('24 */6 * * *', at('2026-07-26T18:25:00Z'))), '2026-07-27T00:24:00.000Z')
})

test('a fire in the current minute counts as past, not next', () => {
  // 12:21:00 exactly — the run is happening now, so "next" is tomorrow's.
  assert.equal(iso(nextCronRun('21 12 * * *', at('2026-07-26T12:21:00Z'))), '2026-07-27T12:21:00.000Z')
  assert.equal(iso(nextCronRun('21 12 * * *', at('2026-07-26T12:20:59Z'))), '2026-07-26T12:21:00.000Z')
})

test('schedules in UTC regardless of the host timezone', () => {
  // sde-mirror, 12:21 UTC. Asserting the instant (not the wall clock) is what
  // catches a getHours()-instead-of-getUTCHours() slip on a non-UTC machine.
  const next = nextCronRun('21 12 * * *', at('2026-07-26T23:30:00Z'))
  assert.equal(iso(next), '2026-07-27T12:21:00.000Z')
})

test('crosses month and year boundaries', () => {
  assert.equal(iso(nextCronRun('57 9 * * *', at('2026-07-31T10:00:00Z'))), '2026-08-01T09:57:00.000Z')
  assert.equal(iso(nextCronRun('41 11 * * *', at('2026-12-31T12:00:00Z'))), '2027-01-01T11:41:00.000Z')
})

test('honours day-of-month and day-of-week restrictions', () => {
  // 2026-07-26 is a Sunday; the next weekday fire is Monday the 27th.
  assert.equal(iso(nextCronRun('0 8 * * 1-5', at('2026-07-26T09:00:00Z'))), '2026-07-27T08:00:00.000Z')
  assert.equal(iso(nextCronRun('0 0 1 * *', at('2026-07-26T09:00:00Z'))), '2026-08-01T00:00:00.000Z')
  // Both restricted: standard cron ORs them, so the 1st *or* any Monday.
  assert.equal(iso(nextCronRun('0 0 1 * 1', at('2026-07-26T09:00:00Z'))), '2026-07-27T00:00:00.000Z')
})

test('gives up rather than looping on an unreachable date', () => {
  // Feb 30 never comes around.
  assert.equal(nextCronRun('0 0 30 2 *', at('2026-07-26T09:00:00Z')), null)
})

test('finds the previous fire, which is what makes a missed run detectable', () => {
  assert.equal(iso(previousCronRun('24 */6 * * *', at('2026-07-26T12:25:00Z'))), '2026-07-26T12:24:00.000Z')
  assert.equal(iso(previousCronRun('24 */6 * * *', at('2026-07-26T12:00:00Z'))), '2026-07-26T06:24:00.000Z')
  // Back across midnight, and back across a year boundary.
  assert.equal(iso(previousCronRun('21 12 * * *', at('2026-07-26T06:00:00Z'))), '2026-07-25T12:21:00.000Z')
  assert.equal(iso(previousCronRun('41 11 * * *', at('2027-01-01T06:00:00Z'))), '2026-12-31T11:41:00.000Z')
})

test('previous and next bracket the moment between them', () => {
  const now = at('2026-07-26T15:07:00Z')
  const previous = previousCronRun('46 */6 * * *', now)
  const next = nextCronRun('46 */6 * * *', now)
  assert.ok(previous !== null && next !== null)
  assert.ok((previous as Date) < now && now < (next as Date))
  assert.equal(iso(previous), '2026-07-26T12:46:00.000Z')
  assert.equal(iso(next), '2026-07-26T18:46:00.000Z')
})
