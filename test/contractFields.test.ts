// Unit coverage for the seam the two contract extracts share
// (src/jobs/contractFields.js): mapping an ESI contract payload onto the columns
// character_contract and corp_contract have in common.
//
// What's worth pinning is everything that would be quietly wrong rather than
// loudly broken — an absent money field becoming 0 instead of null (a courier
// contract has no price, which is not the same as being free), items_fetched_at
// sneaking into the payload and so resetting on every re-scan, and the
// blueprint marker on an item being dropped.
import assert from 'node:assert/strict'
import test from 'node:test'

import { contractFields, contractItemFields, ITEMISED_TYPES } from '../src/jobs/contractFields.js'

const SEEN_AT = '2026-08-09T12:00:00.000Z'

const COURIER = {
  contract_id: 42,
  type: 'courier',
  status: 'in_progress',
  availability: 'corporation',
  for_corporation: true,
  issuer_id: 90000001,
  issuer_corporation_id: 98000001,
  assignee_id: 98000002,
  acceptor_id: 90000002,
  start_location_id: 60003760,
  end_location_id: 1039999999999,
  title: 'Jita → home',
  reward: 12000000.5,
  collateral: 500000000,
  volume: 62000,
  days_to_complete: 5,
  date_issued: '2026-08-01T00:00:00Z',
  date_expired: '2026-08-15T00:00:00Z',
  date_accepted: '2026-08-02T00:00:00Z',
}

test('keeps a money field ESI omitted as null, not zero', () => {
  const row = contractFields(COURIER, SEEN_AT)
  assert.equal(row.reward, 12000000.5)
  assert.equal(row.collateral, 500000000)
  // A courier contract has no price or buyout at all — recording 0 would claim
  // it was contracted for free.
  assert.equal(row.price, null)
  assert.equal(row.buyout, null)
  assert.equal(row.date_completed, null)
})

test('carries the identifying and state columns through', () => {
  const row = contractFields(COURIER, SEEN_AT)
  assert.equal(row.contract_id, 42)
  assert.equal(row.type, 'courier')
  assert.equal(row.status, 'in_progress')
  assert.equal(row.availability, 'corporation')
  assert.equal(row.for_corporation, true)
  assert.equal(row.acceptor_id, 90000002)
  assert.equal(row.title, 'Jita → home')
  assert.equal(row.seen_at, SEEN_AT)
})

test('omits items_fetched_at so a re-scan never re-queues an itemised contract', () => {
  // PostgREST derives the ON CONFLICT update list from the payload's keys, so
  // the column has to be absent — present-and-undefined would still clear it.
  assert.ok(!('items_fetched_at' in contractFields(COURIER, SEEN_AT)))
})

test('defaults the flags ESI leaves off a bare item-exchange contract', () => {
  const row = contractFields(
    {
      contract_id: 7,
      type: 'item_exchange',
      status: 'outstanding',
      availability: 'public',
      issuer_id: 90000001,
      issuer_corporation_id: 98000001,
      price: 0,
      date_issued: '2026-08-01T00:00:00Z',
      date_expired: '2026-08-15T00:00:00Z',
    },
    SEEN_AT
  )
  assert.equal(row.for_corporation, false)
  assert.equal(row.assignee_id, null)
  assert.equal(row.title, null)
  // An explicit zero price is a real fact — a giveaway — and must survive.
  assert.equal(row.price, 0)
})

test('falls back to ESI’s own unknown when the type is missing', () => {
  const row = contractFields(
    {
      contract_id: 8,
      status: 'deleted',
      availability: 'personal',
      issuer_id: 1,
      issuer_corporation_id: 2,
      date_issued: '2026-08-01T00:00:00Z',
      date_expired: '2026-08-15T00:00:00Z',
    },
    SEEN_AT
  )
  assert.equal(row.type, 'unknown')
  // …and an unknown-type contract is not one we spend a request itemising.
  assert.ok(!ITEMISED_TYPES.includes(row.type))
})

test('itemises exactly the contract types that have contents', () => {
  assert.deepEqual([...ITEMISED_TYPES].sort(), ['auction', 'courier', 'item_exchange'])
  assert.ok(!ITEMISED_TYPES.includes('loan'))
})

test('keeps the blueprint marker on an item, and defaults the flags', () => {
  const bpc = contractItemFields({ record_id: 1, type_id: 690, quantity: 1, raw_quantity: -2 }, SEEN_AT)
  assert.equal(bpc.raw_quantity, -2)
  assert.equal(bpc.is_included, true)
  assert.equal(bpc.is_singleton, false)

  const ore = contractItemFields(
    { record_id: 2, type_id: 34, quantity: 1000, is_included: false, is_singleton: false },
    SEEN_AT
  )
  assert.equal(ore.raw_quantity, null)
  assert.equal(ore.is_included, false)
  assert.equal(ore.quantity, 1000)
  assert.equal(ore.seen_at, SEEN_AT)
})
