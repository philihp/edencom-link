// Unit coverage for /contract/[contractId]: the id, which row stands for the
// contract, the two item lists, the status history and the labels.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  blueprintOf,
  contractHeading,
  locationIds,
  moneyLines,
  parseContractId,
  partyIds,
  pickContract,
  splitItems,
  statusHistory,
  statusLabel,
  typeLabel,
  type ContractRow,
} from '../src/app/contract/[contractId]/contract.ts'
import { contractHref } from '../src/app/market/contracts.ts'

const CHARACTER = { kind: 'character', registrationId: 'reg-me' } as const
const CORP = { kind: 'corporation', corporationId: 98000001 } as const

const row = (over: Partial<ContractRow>): ContractRow => ({
  owner: CHARACTER,
  contract_id: '123',
  type: 'item_exchange',
  status: 'finished',
  status_since: '2026-11-01T00:00:00Z',
  availability: 'personal',
  for_corporation: false,
  issuer_id: 90000001,
  issuer_corporation_id: 98000001,
  assignee_id: null,
  acceptor_id: 91000001,
  start_location_id: 60003760,
  end_location_id: null,
  title: null,
  price: '1000000.00',
  reward: '0.00',
  collateral: '0.00',
  buyout: null,
  volume: 10,
  days_to_complete: 0,
  date_issued: '2026-10-30T00:00:00Z',
  date_expired: '2026-11-13T00:00:00Z',
  date_accepted: '2026-11-01T00:00:00Z',
  date_completed: '2026-11-01T00:00:00Z',
  seen_at: '2026-11-01T06:00:00Z',
  ...over,
})

test('parseContractId takes a positive integer and nothing else', () => {
  assert.equal(parseContractId('219876543'), 219876543)
  assert.equal(parseContractId('0'), null)
  assert.equal(parseContractId('-5'), null)
  assert.equal(parseContractId('12a'), null)
  assert.equal(parseContractId('1.5'), null)
  assert.equal(parseContractId(''), null)
  assert.equal(parseContractId('99999999999999999999'), null)
})

test('pickContract: none read is null', () => {
  assert.equal(pickContract([]), null)
})

test('pickContract: a personal contract prefers the character row', () => {
  const corp = row({ owner: CORP })
  const character = row({ owner: CHARACTER })
  assert.equal(pickContract([corp, character]), character)
  assert.equal(pickContract([character, corp]), character)
})

test('pickContract: a for-corporation contract prefers the corporation row', () => {
  const corp = row({ owner: CORP, for_corporation: true })
  const character = row({ owner: CHARACTER, for_corporation: true })
  assert.equal(pickContract([character, corp]), corp)
})

test('pickContract: one row is that row, whichever owner', () => {
  const corp = row({ owner: CORP })
  assert.equal(pickContract([corp]), corp)
})

test('splitItems: included are offered, the rest asked for, in record order, once each', () => {
  const lines = splitItems([
    { record_id: '3', type_id: '35', quantity: '5', is_included: false, is_singleton: false, raw_quantity: null },
    { record_id: 1, type_id: 34, quantity: 100, is_included: true, is_singleton: false, raw_quantity: null },
    { record_id: '2', type_id: '1000', quantity: '1', is_included: true, is_singleton: true, raw_quantity: '-2' },
    { record_id: '1', type_id: '34', quantity: '100', is_included: true, is_singleton: false, raw_quantity: null },
  ])
  assert.deepEqual(lines, {
    offered: [
      { recordId: 1, typeId: 34, quantity: 100, singleton: false, blueprint: null },
      { recordId: 2, typeId: 1000, quantity: 1, singleton: true, blueprint: 'copy' },
    ],
    asked: [{ recordId: 3, typeId: 35, quantity: 5, singleton: false, blueprint: null }],
  })
})

test('blueprintOf reads ESI raw_quantity markers', () => {
  assert.equal(blueprintOf(-1), 'original')
  assert.equal(blueprintOf('-2'), 'copy')
  assert.equal(blueprintOf(null), null)
  assert.equal(blueprintOf(5), null)
})

test("statusHistory keeps the chosen owner's steps, oldest first", () => {
  const steps = statusHistory(CHARACTER, [
    { owner: CHARACTER, status: 'finished', valid_from: '2026-11-02T00:00:00Z', valid_until: '2026-11-20T00:00:00Z' },
    { owner: CORP, status: 'in_progress', valid_from: '2026-11-01T12:00:00Z', valid_until: '2026-11-01T18:00:00Z' },
    {
      owner: CHARACTER,
      status: 'outstanding',
      valid_from: '2026-10-30T00:00:00Z',
      valid_until: '2026-11-01T00:00:00Z',
    },
  ])
  assert.deepEqual(steps, [
    { status: 'outstanding', from: '2026-10-30T00:00:00Z', until: '2026-11-01T00:00:00Z' },
    { status: 'finished', from: '2026-11-02T00:00:00Z', until: '2026-11-20T00:00:00Z' },
  ])
})

test('partyIds and locationIds: distinct, numeric, nulls dropped', () => {
  assert.deepEqual(
    partyIds(row({ issuer_id: '90000001', acceptor_id: '90000001', assignee_id: null })),
    [90000001, 98000001]
  )
  assert.deepEqual(
    locationIds(row({ type: 'courier', start_location_id: '60003760', end_location_id: 1035466617946 })),
    [60003760, 1035466617946]
  )
  assert.deepEqual(locationIds(row({ start_location_id: null })), [])
})

test('labels: known values read well, unknown ones pass through', () => {
  assert.equal(typeLabel('item_exchange'), 'Item exchange')
  assert.equal(typeLabel('new_kind'), 'new kind')
  assert.equal(statusLabel('finished_issuer'), 'Finished (issuer)')
  assert.equal(statusLabel(null), '—')
})

test('contractHeading: the title, else the type and the id', () => {
  assert.equal(contractHeading(row({ title: '  Rifter kit ' })), 'Rifter kit')
  assert.equal(contractHeading(row({ title: '' })), 'Item exchange 123')
  assert.equal(contractHeading(row({ type: 'courier', title: null })), 'Courier 123')
})

test('moneyLines: the columns that apply to the type, zeroes left out', () => {
  assert.deepEqual(moneyLines(row({})), [{ label: 'Price', isk: 1000000 }])
  assert.deepEqual(moneyLines(row({ type: 'courier', reward: '5000000', collateral: '200000000', price: '0' })), [
    { label: 'Reward', isk: 5000000 },
    { label: 'Collateral', isk: 200000000 },
  ])
  assert.deepEqual(moneyLines(row({ type: 'auction', price: '10', buyout: '100' })), [
    { label: 'Starting bid', isk: 10 },
    { label: 'Buyout', isk: 100 },
  ])
  assert.deepEqual(moneyLines(row({ price: '0', reward: null })), [])
})

test('contractHref is the contract page', () => {
  assert.equal(contractHref(219876543), '/contract/219876543')
})
