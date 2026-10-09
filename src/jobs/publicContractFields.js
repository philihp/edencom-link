import { all, chain, map, splitEvery, transpose, uniq } from 'ramda'

// The pure rules of the public-contracts extract (src/jobs/publicContracts.js).
// No I/O; tested in test/publicContractFields.test.ts. What is worth pinning is
// what would be quietly wrong rather than loudly broken: a listing missing a
// page read as a wave of closures, a money field that is absent becoming 0,
// and a courier sent to the items route.

// ESI's page size for /contracts/public/{region_id}/. Every page but the last
// is full, which is what makes a short middle page detectable.
export const CONTRACTS_PAGE_SIZE = 1000

// The only types the public items route answers. A courier gets a 400 ("not an
// item exchange or auction"), and a 400 spends ESI's error budget, so it is
// never asked. Loans and unknowns have nothing to list.
export const PUBLIC_ITEMISED_TYPES = ['item_exchange', 'auction']

// How long a closed contract stays in the table.
export const RETENTION_DAYS = 30

// A listing at or above this size that shrinks to under SHRINK_FLOOR of itself
// in one snapshot is held for a while instead of closing most of the region.
export const SHRINK_MIN_PREVIOUS = 100
export const SHRINK_FLOOR = 0.1
export const SUSPECT_HOLD_MS = 6 * 60 * 60 * 1000

const numberOrNull = (value) => (value == null ? null : Number(value))

// An HTTP date (ESI's Last-Modified / Expires) as ISO, or null when absent or
// unparseable.
export const httpDate = (value) => {
  if (value == null || value === '') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

// One listed contract → its public_contract row. `observedAt` is the
// snapshot's time, stamped by the caller on every row of the region.
export const publicContractRow = (c, regionId, observedAt) => ({
  contract_id: c.contract_id,
  region_id: regionId,
  type: c.type ?? 'unknown',
  issuer_id: c.issuer_id,
  issuer_corporation_id: c.issuer_corporation_id,
  for_corporation: c.for_corporation ?? false,
  start_location_id: c.start_location_id ?? null,
  end_location_id: c.end_location_id ?? null,
  title: c.title ?? null,
  price: numberOrNull(c.price),
  reward: numberOrNull(c.reward),
  collateral: numberOrNull(c.collateral),
  buyout: numberOrNull(c.buyout),
  volume: numberOrNull(c.volume),
  days_to_complete: c.days_to_complete ?? null,
  date_issued: c.date_issued,
  date_expired: c.date_expired,
  first_seen_at: observedAt,
})

// One item of a public contract → its public_contract_item row.
export const publicContractItemRow = (contractId, item) => ({
  contract_id: contractId,
  record_id: item.record_id,
  type_id: item.type_id,
  quantity: item.quantity,
  is_included: item.is_included ?? true,
  is_blueprint_copy: item.is_blueprint_copy ?? null,
  item_id: item.item_id ?? null,
  material_efficiency: item.material_efficiency ?? null,
  time_efficiency: item.time_efficiency ?? null,
  runs: item.runs ?? null,
})

// Whether a region's pages add up to one whole snapshot. The sweep closes
// every stored contract a listing lacks, so a listing must not be trusted
// unless all of these hold:
//
//   - every page arrived, as many as the first page's X-Pages declared, and
//     each is a list (a page past the end comes back as a 200 carrying
//     { error: 'Requested page does not exist!' }, so a listing that shrank
//     during the read shows up here);
//   - every page but the last is full (a short middle page lost rows);
//   - all pages share one Last-Modified (ESI regenerated the snapshot mid-read,
//     so contracts may have shifted between pages);
//   - no contract id appears twice (the same shift, seen from the other side).
//
// `pages` is [{ rows, lastModified }] in page order.
export const listingCheck = (pages, declaredPages) => {
  if (pages.length === 0) return { complete: false, reason: 'no pages' }
  const declared = Math.max(1, Number.parseInt(declaredPages, 10) || 1)
  if (pages.length !== declared) return { complete: false, reason: `got ${pages.length} of ${declared} pages` }
  if (!all((page) => Array.isArray(page.rows), pages)) return { complete: false, reason: 'a page is not a list' }
  const fullBeforeLast = all((page) => page.rows.length === CONTRACTS_PAGE_SIZE, pages.slice(0, -1))
  if (!fullBeforeLast) return { complete: false, reason: 'a page before the last is short' }
  const stamps = uniq(map((page) => page.lastModified ?? null, pages))
  if (stamps.length !== 1) return { complete: false, reason: 'pages come from different snapshots' }
  const ids = chain((page) => map((c) => c.contract_id, page.rows), pages)
  if (new Set(ids).size !== ids.length) return { complete: false, reason: 'a contract is listed twice' }
  return { complete: true, reason: null }
}

// Whether a listing may be cut short at its newest end. ESI lists a region in
// ascending contract id and stops at its last page, and The Forge is served as
// exactly 35 full pages with nothing from its last ~45 minutes (seen
// 2026-10-09): the newest contracts wait above the cut until older ones close.
// A full last page is the only sign of that in the response. It does not make
// closures wrong: ids only grow, so a contract once listed cannot be pushed out
// by the cut, only by closing. It does mean a capped region's newest contracts
// are not stored yet.
export const listingCapped = (pages) => pages.length > 0 && pages[pages.length - 1].rows.length === CONTRACTS_PAGE_SIZE

// Whether to accept a listing that has shrunk a lot since the last one. A
// region going from hundreds of contracts to almost none inside one snapshot
// is far likelier to be a bad answer from ESI than a real market, and
// accepting it would close almost the whole region. So hold it: close nothing,
// and start (or keep) a suspect clock. A shrink that persists past
// SUSPECT_HOLD_MS is accepted as real, so a region that truly empties is not
// held open forever.
//
// Answers 'accept' or 'hold'.
export const shrinkVerdict = ({ previousOpen, listed, suspectSince, now }) => {
  const sharp = previousOpen >= SHRINK_MIN_PREVIOUS && listed < previousOpen * SHRINK_FLOOR
  if (!sharp) return 'accept'
  if (suspectSince == null) return 'hold'
  return now - Date.parse(suspectSince) >= SUSPECT_HOLD_MS ? 'accept' : 'hold'
}

// Whether a region is due: never seen, or ESI's cache of its last snapshot has
// expired (asking sooner returns the same snapshot).
export const regionDue = (state, now) => {
  if (state?.expires_at == null) return true
  return Date.parse(state.expires_at) <= now
}

// The oldest closed_at to keep.
export const retentionCutoff = (now, days = RETENTION_DAYS) => new Date(now - days * 24 * 60 * 60 * 1000).toISOString()

// Deal items round-robin into at most `lanes` lanes, each drained in order by
// the caller. The same shape the per-character workflows use, so concurrency
// stays bounded without a pool.
export const intoLanes = (lanes, items) => (items.length === 0 ? [] : transpose(splitEvery(lanes, items)))
