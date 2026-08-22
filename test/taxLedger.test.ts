// Sorting industry_job_tax journal entries into revenue, cost-avoidance basis,
// and neither. The case that drove this: a corporation that installs every job
// AS THE CORPORATION into its own structure pays the facility tax out of the
// corp wallet and receives it into the same wallet, so CCP writes only the
// outgoing side. Every entry is negative, no receipt exists to scale, and the
// page reported zero cost avoidance for a corp that was avoiding it constantly.
import assert from 'node:assert/strict'
import test from 'node:test'

import { foldTaxLedger } from '../src/app/structure/taxLedger.ts'
import type { TaxEntry } from '../src/app/structure/taxLedger.ts'

const OURS = 'corp-1'
const ALLY = 'corp-2'

// Job J1 ran in our structure S1; job J2 in an alliance-mate's structure S2.
const input = {
  structureByJob: new Map([
    ['J1', 'S1'],
    ['J2', 'S2'],
    ['J3', 'S1'],
  ]),
  ownJobIds: new Set(['J1', 'J2']),
  structureOwner: new Map([
    ['S1', OURS],
    ['S2', ALLY],
  ]),
}

const entry = (over: Partial<TaxEntry>): TaxEntry => ({
  amount: 0,
  corporationId: OURS,
  jobIds: [],
  payerId: null,
  ...over,
})

test('an incoming payment for our own job is both revenue and an own-rate receipt', () => {
  const ledger = foldTaxLedger([entry({ amount: 5_000, jobIds: ['J1'] })], input)
  assert.deepEqual([...ledger.revenueByStructure], [['S1', 5_000]])
  assert.deepEqual(ledger.ownReceipts, [{ structureId: 'S1', amount: 5_000 }])
})

test("a renter's payment is revenue but not ours to have avoided", () => {
  const ledger = foldTaxLedger([entry({ amount: 5_000, jobIds: ['J3'] })], input)
  assert.deepEqual([...ledger.revenueByStructure], [['S1', 5_000]])
  assert.deepEqual(ledger.ownReceipts, [])
})

test('tax our corp paid itself is an own-rate receipt, and is never revenue', () => {
  const ledger = foldTaxLedger([entry({ amount: -9_007, jobIds: ['J1'] })], input)
  assert.deepEqual(ledger.ownReceipts, [{ structureId: 'S1', amount: 9_007 }])
  assert.equal(ledger.revenueByStructure.size, 0)
  assert.equal(ledger.unaccounted, 0)
})

test("tax paid into somebody else's structure is a real expense — neither figure", () => {
  const ledger = foldTaxLedger([entry({ amount: -9_007, jobIds: ['J2'] })], input)
  assert.deepEqual(ledger.ownReceipts, [])
  assert.equal(ledger.revenueByStructure.size, 0)
  assert.equal(ledger.unaccounted, 0)
})

test('an outgoing entry never lands in unaccounted, which is a revenue bucket', () => {
  const ledger = foldTaxLedger([entry({ amount: -9_007, jobIds: ['unknown-job'], payerId: '99' })], input)
  assert.equal(ledger.unaccounted, 0)
  assert.deepEqual([...ledger.unaccountedByParty], [])
})

test('incoming tax for a job we cannot place is unaccounted, broken down by payer', () => {
  const ledger = foldTaxLedger([entry({ amount: 1_200, jobIds: ['nope'], payerId: '42' })], input)
  assert.equal(ledger.unaccounted, 1_200)
  assert.deepEqual([...ledger.unaccountedByParty], [['42', 1_200]])
})

test('an unattributable payment with no payer is bucketed as unknown', () => {
  const ledger = foldTaxLedger([entry({ amount: 300, jobIds: [] })], input)
  assert.deepEqual([...ledger.unaccountedByParty], [['unknown', 300]])
})

test('both sides of one charge credit the job once, not twice', () => {
  const ledger = foldTaxLedger(
    [entry({ amount: 5_000, jobIds: ['J1'] }), entry({ amount: -5_000, jobIds: ['J1'] })],
    input
  )
  assert.deepEqual(ledger.ownReceipts, [{ structureId: 'S1', amount: 5_000 }])
})

test('an outgoing entry from a corporation that does not own the structure is dropped', () => {
  const ledger = foldTaxLedger([entry({ amount: -9_007, corporationId: ALLY, jobIds: ['J1'] })], input)
  assert.deepEqual(ledger.ownReceipts, [])
})

test('the description fallback is used only when context_id resolved nothing', () => {
  const ledger = foldTaxLedger([entry({ amount: -1_000, jobIds: ['555', 'J1'] })], input)
  assert.deepEqual(ledger.ownReceipts, [{ structureId: 'S1', amount: 1_000 }])
})

test('zero and non-numeric amounts are ignored rather than crediting a phantom job', () => {
  const ledger = foldTaxLedger(
    [entry({ amount: 0, jobIds: ['J1'] }), entry({ amount: Number.NaN, jobIds: ['J1'] })],
    input
  )
  assert.deepEqual(ledger.ownReceipts, [])
  assert.equal(ledger.revenueByStructure.size, 0)
})

test('receipts accumulate per structure across many entries', () => {
  const ledger = foldTaxLedger(
    [
      entry({ amount: -9_007, jobIds: ['J1'] }),
      entry({ amount: -82_249, jobIds: ['J3'] }),
      entry({ amount: -3_487, jobIds: ['J2'] }),
    ],
    input
  )
  assert.deepEqual(ledger.ownReceipts, [
    { structureId: 'S1', amount: 9_007 },
    { structureId: 'S1', amount: 82_249 },
  ])
})
