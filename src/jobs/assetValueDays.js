// Pure day arithmetic for the asset value backfill (src/jobs/assetValues.js),
// apart from it so a test can import it without a database client.
import { filter, map, reduce, reject } from 'ramda'

const DAY_MS = 86_400_000

export const utcDay = (t) => new Date(t).toISOString().slice(0, 10)

// Every UTC day from `from` to `to`, inclusive, as YYYY-MM-DD.
export const daysBetween = (from, to) =>
  Array.from({ length: Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS) + 1) }, (_, i) =>
    utcDay(Date.parse(from) + i * DAY_MS)
  )

// The backfill's order: day by day from the earliest, and on each day every
// owner with history by then. An owner's history begins at its first asset
// version, never before the price record or `since`. A day an owner already
// has (`done`, a Set of "<key>|<day>") is left out, and a day nobody needs is
// dropped.
//
//   owners: [{ key, first }]  (first: the owner's first asset day)
//   → [{ day, keys }]
export const backfillPlan = ({ owners, priceStart, since = null, today, done = new Set() }) => {
  const starts = map((o) => ({ key: o.key, from: [o.first, priceStart, since ?? o.first].sort().at(-1) }), owners)
  const earliest = reduce((min, s) => (min && min < s.from ? min : s.from), null, starts)
  if (!earliest) return []
  return reject(
    (step) => step.keys.length === 0,
    map(
      (day) => ({
        day,
        keys: map(
          (s) => s.key,
          filter((s) => s.from <= day && !done.has(`${s.key}|${day}`), starts)
        ),
      }),
      daysBetween(earliest, today)
    )
  )
}
