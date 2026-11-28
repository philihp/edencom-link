// Pure day arithmetic for the asset value backfill (src/jobs/assetValues.js),
// apart from it so a test can import it without a database client.
import { difference, filter, groupWith, isEmpty, map, pipe, prop, reject, splitAt, splitEvery } from 'ramda'

const DAY_MS = 86_400_000

export const utcDay = (t) => new Date(t).toISOString().slice(0, 10)

// Every UTC day from `from` to `to`, inclusive, as YYYY-MM-DD.
export const daysBetween = (from, to) =>
  Array.from({ length: Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS) + 1) }, (_, i) =>
    utcDay(Date.parse(from) + i * DAY_MS)
  )

const nextDay = (a, b) => Date.parse(b) - Date.parse(a) === DAY_MS

// The days still to compute, from `from` to `to`, less the ones already done,
// as runs of consecutive days of at most `size` each. One run is one RPC call,
// which takes a first and a last day, so a run never spans a day already done.
export const pendingRuns = (from, to, done, size) =>
  groupWith(nextDay, difference(daysBetween(from, to), done)).flatMap(splitEvery(size))

// A run in two halves, the first the longer: what a timed-out call retries as.
export const halve = (days) => splitAt(Math.ceil(days.length / 2), days)

// The backfill's order: every day from the earliest owner's start to `to`, and
// on each day every owner whose history has begun by then, less the
// (owner, day) pairs already done. `owners` carry `key` and `from` (their first
// day to value); `done` maps a key to the days already computed for it.
export const dayMajorPlan = (owners, to, done = {}) => {
  const start = owners.map((o) => o.from).sort()[0]
  if (!start) return []
  return pipe(
    map((day) => ({
      day,
      owners: filter((o) => o.from <= day && !(done[o.key] ?? []).includes(day), owners),
    })),
    reject(pipe(prop('owners'), isEmpty))
  )(daysBetween(start, to))
}
