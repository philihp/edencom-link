import { filter, map, pipe, reduce } from 'ramda'

// Pure seam shared by the market-adjusted-prices job and its tests: turn ESI's
// GET /markets/prices/ listing into the columns
// market_adjusted_price_over_time versions on, and classify each one against
// the currently-open rows. The SCD-2 decision is the part that is easy to get
// subtly wrong, so it has no I/O and runs under `pnpm test`. The shape is
// marketPriceReconcile.js's, minus the market dimension: CCP publishes one
// adjusted price per type for all of New Eden.

// ESI's listing is the whole universe in one unpaginated response (~15k
// types). A short one is a truncated or failed response, not a mass
// delisting, and reconciling it would close thousands of prices at once; the
// job refuses below this floor.
export const MIN_PLAUSIBLE_TYPES = 10000

// ISK carries two decimals, and the game displays adjusted prices at that
// precision; CCP's feed carries many more. Rounding damps float-formatting
// drift that would otherwise open a version for a price that did not move
// in any sense a reader could see.
const round2 = (value) => {
  if (value === null || value === undefined) return null
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null
}

// One listing entry → the row shape stored. An entry without a usable type id
// or adjusted price is dropped rather than stored under a null key or as a
// price of nothing; average_price is absent for ~13% of types, and null then
// means "not published", which is different from zero.
const normalizeEntry = (entry) => {
  const raw = entry?.type_id
  if (raw === null || raw === undefined || raw === '') return null
  const type_id = Number(raw)
  if (!Number.isFinite(type_id)) return null
  const adjusted_price = round2(entry?.adjusted_price)
  if (adjusted_price === null) return null
  return { type_id, adjusted_price, average_price: round2(entry?.average_price) }
}

// The whole listing → storable rows, deduped on type id (last entry wins; a
// duplicate would otherwise collide with the one-open-row-per-type index).
export const normalizeAdjustedPrices = (feed) =>
  pipe(
    map(normalizeEntry),
    filter(Boolean),
    reduce((byType, row) => byType.set(row.type_id, row), new Map()),
    (byType) => [...byType.values()]
  )(feed ?? [])

// What defines a version: both published prices. Two sightings with the same
// signature are the same row; a move in either opens a new one.
export const signature = (row) => JSON.stringify([round2(row.adjusted_price), round2(row.average_price)])

// Classify each fetched price against the open rows: unchanged → touch
// (valid_until bumped), changed → close the open row and insert the next,
// new → insert, and a type that left the listing → close with no
// replacement. The id lists are type ids: (type_id) is unique among
// is_current rows, so a type id plus the caller's is_current filter addresses
// exactly one row.
export const partitionAdjustedPrices = (current, fetched) => {
  const currentByType = new Map(map((row) => [Number(row.type_id), row], current ?? []))
  const seen = new Set()

  // Push-mutated accumulator: ~15k rows a run, and re-spreading per item
  // would make this O(n^2).
  const { touchIds, closeIds, inserts } = reduce(
    (acc, row) => {
      seen.add(row.type_id)
      const open = currentByType.get(row.type_id)
      if (open && signature(open) === signature(row)) {
        acc.touchIds.push(row.type_id)
      } else {
        if (open) acc.closeIds.push(row.type_id)
        // valid_from is left to its `default now()` so it marks this version's debut.
        acc.inserts.push(row)
      }
      return acc
    },
    { touchIds: [], closeIds: [], inserts: [] },
    fetched ?? []
  )

  const goneIds = pipe(
    map((row) => Number(row.type_id)),
    filter((typeId) => !seen.has(typeId))
  )(current ?? [])

  return { touchIds, closeIds: [...closeIds, ...goneIds], inserts }
}
