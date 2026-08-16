import { filter, map, pipe, reduce } from 'ramda'

// Pure seam shared by the market-prices job and its tests: turn the
// appraise.gnf.lt feed into the columns market_price_over_time versions on,
// and classify each one against the market's currently-open rows. No I/O, so
// the SCD-2 decision — the part that is easy to get subtly wrong and expensive
// to get wrong at 20k rows an hour — is testable under `pnpm test`.

// EVE prices carry at most two decimals; the feed's own min/max are exact
// order prices, not averages, so rounding here only damps float-formatting
// drift (72499999999.90000001 vs 72499999999.9) that would otherwise open a
// new version every hour for a price nobody moved.
const round2 = (value) => {
  if (value === null || value === undefined) return null
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null
}

// The best bid / best ask, or null when nothing is on that side of the book.
// order_count is the authoritative "is there a book here" flag — an empty side
// still reports a numeric max/min (0), which would otherwise be stored as a
// real price of zero.
const bestPrice = (side, field) => (side && Number(side.order_count) > 0 ? round2(side[field]) : null)

// One feed entry → the row shape we store. Entries without a usable type id
// are dropped rather than stored under a null key.
const normalizeEntry = (entry) => {
  // Number(null) and Number('') are both 0, which is finite — so a missing type
  // id would otherwise be stored as a real price row for type 0.
  const raw = entry?.typeID
  if (raw === null || raw === undefined || raw === '') return null
  const type_id = Number(raw)
  if (!Number.isFinite(type_id)) return null
  const prices = entry?.prices ?? {}
  return {
    type_id,
    buy_max: bestPrice(prices.buy, 'max'),
    sell_min: bestPrice(prices.sell, 'min'),
    strategy: typeof prices.strategy === 'string' ? prices.strategy : null,
  }
}

// The whole feed → storable rows, deduped on type id (last entry wins; the
// service has never shipped a duplicate, but a duplicate would otherwise
// collide with the one-open-row-per-(market, type) unique index).
export const normalizePrices = (feed) =>
  pipe(
    map(normalizeEntry),
    filter(Boolean),
    reduce((byType, row) => byType.set(row.type_id, row), new Map()),
    (byType) => [...byType.values()]
  )(feed ?? [])

// The tracked attributes that define a version of a price row. Two sightings
// with the same signature are the "same" row; a move in either side of the
// book — or a change in how the service derived the price — opens a new one.
// Deliberately excludes volume/order_count and the feed's per-type `updated`
// stamp: those churn every hour for essentially every type, which would turn
// this table into an append-only firehose (~20k rows/market/hour) and destroy
// the compression the SCD-2 shape exists to provide. "How fresh is this row"
// is answered by valid_until, which every run bumps.
export const signature = (row) => JSON.stringify([round2(row.buy_max), round2(row.sell_min), row.strategy ?? null])

// Classify each fetched price against the market's current (open) rows:
// unchanged prices get their valid_until extended, changed ones have their old
// row closed and a new one inserted, and a type that has left the feed
// entirely is closed without a replacement.
//
// Unlike the character-skills reconcile, vanishing IS meaningful here: the feed
// is a complete listing of every type the market knows about on every fetch, so
// a type dropping out means the service stopped pricing it. The caller is
// responsible for only reaching this with a plausibly-complete feed
// (MIN_PLAUSIBLE_TYPES in src/gnfMarket.js) — a truncated response would
// otherwise read as a mass delisting.
//
// The two id lists are **type ids, not row ids**. This table carries no
// surrogate key: among a market's is_current rows (market, type_id) is unique,
// which the partial unique index enforces, so a type id plus the caller's
// market and is_current filter addresses exactly one row. That saves the bigint
// and its btree — ~19% of the largest table in the database — for no loss of
// addressability (docs/market-prices/README.md "Storage").
export const partitionPrices = (market, current, fetched) => {
  const currentByType = new Map(map((row) => [Number(row.type_id), row], current ?? []))
  const seen = new Set()

  // Plain push-mutated accumulator — a market carries north of 20k types, and
  // re-spreading per item would turn this into O(n^2).
  const { touchIds, closeIds, inserts } = reduce(
    (acc, row) => {
      seen.add(row.type_id)
      const open = currentByType.get(row.type_id)
      if (open && signature(open) === signature(row)) {
        acc.touchIds.push(row.type_id)
      } else {
        if (open) acc.closeIds.push(row.type_id)
        // valid_from is left to its `default now()` so it marks this version's debut.
        acc.inserts.push({ market, ...row })
      }
      return acc
    },
    { touchIds: [], closeIds: [], inserts: [] },
    fetched ?? []
  )

  // Types the feed no longer prices: close the open row, open nothing.
  const goneIds = pipe(
    map((row) => Number(row.type_id)),
    filter((typeId) => !seen.has(typeId))
  )(current ?? [])

  return { touchIds, closeIds: [...closeIds, ...goneIds], inserts }
}
