// Unit coverage for the public-contracts extract's pure rules
// (src/jobs/publicContractFields.js). The sweep closes every stored contract
// a listing lacks, so the cases worth pinning are the ones where a bad listing
// would quietly read as a wave of closures: a missing or short page, pages
// from two snapshots, a contract listed twice, and a region that suddenly
// empties. Plus the field mapping, where an absent money field must stay null.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CONTRACTS_PAGE_SIZE,
  httpDate,
  intoLanes,
  listingCapped,
  listingCheck,
  publicContractItemRow,
  publicContractRow,
  regionDue,
  shrinkVerdict,
  SUSPECT_HOLD_MS,
} from '../src/jobs/publicContractFields.js'

const SNAPSHOT = 'Fri, 09 Oct 2026 03:39:24 GMT'

const contracts = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => ({ contract_id: from + i, type: 'item_exchange' }))

const page = (rows: Array<{ contract_id: number }>, lastModified: string | null = SNAPSHOT) => ({ rows, lastModified })

test('a whole listing is complete', () => {
  const pages = [page(contracts(1, CONTRACTS_PAGE_SIZE)), page(contracts(5001, 12))]
  assert.deepEqual(listingCheck(pages, '2'), { complete: true, reason: null })
})

test('an empty region is a complete listing', () => {
  assert.deepEqual(listingCheck([page([])], '1'), { complete: true, reason: null })
})

test('a missing header reads as one page', () => {
  assert.equal(listingCheck([page(contracts(1, 3))], null).complete, true)
})

test('fewer pages than declared is incomplete', () => {
  const check = listingCheck([page(contracts(1, CONTRACTS_PAGE_SIZE))], '2')
  assert.equal(check.complete, false)
  assert.match(check.reason ?? '', /1 of 2/)
})

test('a short page before the last is incomplete', () => {
  const pages = [page(contracts(1, 999)), page(contracts(5001, 12))]
  assert.equal(listingCheck(pages, '2').complete, false)
})

test('pages from two snapshots are incomplete', () => {
  const pages = [page(contracts(1, CONTRACTS_PAGE_SIZE)), page(contracts(5001, 12), 'Fri, 09 Oct 2026 04:09:24 GMT')]
  const check = listingCheck(pages, '2')
  assert.equal(check.complete, false)
  assert.match(check.reason ?? '', /different snapshots/)
})

test('a contract listed twice is incomplete', () => {
  const first = contracts(1, CONTRACTS_PAGE_SIZE)
  const pages = [page(first), page([{ contract_id: 1 }])]
  assert.equal(listingCheck(pages, '2').complete, false)
})

test('a page past the end answers an error object, which is incomplete', () => {
  const pages = [
    page(contracts(1, CONTRACTS_PAGE_SIZE)),
    {
      rows: { error: 'Requested page does not exist!' } as unknown as Array<{ contract_id: number }>,
      lastModified: SNAPSHOT,
    },
  ]
  const check = listingCheck(pages, '2')
  assert.equal(check.complete, false)
  assert.match(check.reason ?? '', /not a list/)
})

test('no pages at all is incomplete', () => {
  assert.equal(listingCheck([], '1').complete, false)
})

test('a full last page marks the listing as possibly capped', () => {
  assert.equal(
    listingCapped([page(contracts(1, CONTRACTS_PAGE_SIZE)), page(contracts(5001, CONTRACTS_PAGE_SIZE))]),
    true
  )
  assert.equal(listingCapped([page(contracts(1, CONTRACTS_PAGE_SIZE)), page(contracts(5001, 12))]), false)
  assert.equal(listingCapped([page([])]), false)
  assert.equal(listingCapped([]), false)
})

test('a contract maps to its row, and absent money fields stay null', () => {
  const row = publicContractRow(
    {
      contract_id: 235924154,
      type: 'courier',
      issuer_id: 90000001,
      issuer_corporation_id: 98000001,
      start_location_id: 60003760,
      end_location_id: 1035466617946,
      reward: 25000000,
      collateral: 1500000000,
      volume: 60000,
      days_to_complete: 3,
      date_issued: '2026-10-08T12:00:00Z',
      date_expired: '2026-10-22T12:00:00Z',
    },
    10000002,
    '2026-10-09T03:39:24.000Z'
  )
  assert.equal(row.region_id, 10000002)
  assert.equal(row.price, null)
  assert.equal(row.buyout, null)
  assert.equal(row.reward, 25000000)
  assert.equal(row.for_corporation, false)
  assert.equal(row.title, null)
  assert.equal(row.first_seen_at, '2026-10-09T03:39:24.000Z')
  // The status lives in its own table, and the item bookkeeping is set later,
  // so neither is ever in the facts' insert payload.
  assert.equal('status' in row, false)
  assert.equal('items_fetched_at' in row, false)
})

test('a contract with no type is stored as unknown', () => {
  const row = publicContractRow(
    {
      contract_id: 1,
      issuer_id: 1,
      issuer_corporation_id: 1,
      date_issued: '2026-10-08T12:00:00Z',
      date_expired: '2026-10-22T12:00:00Z',
    },
    10000002,
    '2026-10-09T03:39:24.000Z'
  )
  assert.equal(row.type, 'unknown')
})

test('an item maps to its row, keeping blueprint details', () => {
  const row = publicContractItemRow(235924154, {
    is_blueprint_copy: true,
    is_included: true,
    item_id: 1052429026040,
    material_efficiency: 4,
    quantity: 1,
    record_id: 5312395612,
    runs: 8,
    time_efficiency: 4,
    type_id: 28849,
  })
  assert.deepEqual(row, {
    contract_id: 235924154,
    record_id: 5312395612,
    type_id: 28849,
    quantity: 1,
    is_included: true,
    is_blueprint_copy: true,
    item_id: 1052429026040,
    material_efficiency: 4,
    time_efficiency: 4,
    runs: 8,
  })
})

test('a requested item has no item id and is not included', () => {
  const row = publicContractItemRow(7, { is_included: false, quantity: 5, record_id: 1, type_id: 34 })
  assert.equal(row.is_included, false)
  assert.equal(row.item_id, null)
  assert.equal(row.is_blueprint_copy, null)
})

test('an ordinary change in a listing is accepted', () => {
  assert.equal(shrinkVerdict({ previousOpen: 35000, listed: 34100, suspectSince: null, now: 0 }), 'accept')
  assert.equal(shrinkVerdict({ previousOpen: 40, listed: 0, suspectSince: null, now: 0 }), 'accept')
})

test('a large region collapsing in one snapshot is held', () => {
  assert.equal(shrinkVerdict({ previousOpen: 35000, listed: 0, suspectSince: null, now: 0 }), 'hold')
  assert.equal(shrinkVerdict({ previousOpen: 200, listed: 19, suspectSince: null, now: 0 }), 'hold')
})

test('a collapse that persists past the hold is accepted as real', () => {
  const since = '2026-10-09T00:00:00.000Z'
  const start = Date.parse(since)
  assert.equal(shrinkVerdict({ previousOpen: 200, listed: 0, suspectSince: since, now: start + 1000 }), 'hold')
  assert.equal(
    shrinkVerdict({ previousOpen: 200, listed: 0, suspectSince: since, now: start + SUSPECT_HOLD_MS }),
    'accept'
  )
})

test('a region is due when never seen or when its cache has expired', () => {
  const now = Date.parse('2026-10-09T04:00:00Z')
  assert.equal(regionDue(undefined, now), true)
  assert.equal(regionDue({ expires_at: null }, now), true)
  assert.equal(regionDue({ expires_at: '2026-10-09T03:59:59Z' }, now), true)
  assert.equal(regionDue({ expires_at: '2026-10-09T04:09:24Z' }, now), false)
})

test('HTTP dates become ISO, and junk becomes null', () => {
  assert.equal(httpDate(SNAPSHOT), '2026-10-09T03:39:24.000Z')
  assert.equal(httpDate(null), null)
  assert.equal(httpDate(''), null)
  assert.equal(httpDate('not a date'), null)
})

test('lanes deal items round-robin and never exceed the lane count', () => {
  assert.deepEqual(intoLanes(3, [1, 2, 3, 4, 5, 6, 7]), [
    [1, 4, 7],
    [2, 5],
    [3, 6],
  ])
  assert.deepEqual(intoLanes(4, [1, 2]), [[1], [2]])
  assert.deepEqual(intoLanes(4, []), [])
})
