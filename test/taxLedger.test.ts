// Sorting industry_job_tax journal entries into revenue, tax we paid,
// cost-avoidance basis, and none of those. The case that drove the fold: a
// corporation that installs every job AS THE CORPORATION into its own structure
// pays the facility tax out of the corp wallet and receives it into the same
// wallet, so CCP writes only the outgoing side. Every entry is negative, no
// receipt exists to scale, and the page reported zero cost avoidance for a corp
// that was avoiding it constantly.
//
// What the three measures must not do is collapse into each other. One charge
// can be revenue AND tax we paid (a member billing their own corp), or tax we
// paid and no revenue at all (the corp billing itself), and it is avoidance
// only when the installer's own corporation owns the structure — never merely
// because the job was ours.
import assert from 'node:assert/strict'
import test from 'node:test'

import { foldTaxLedger } from '../src/app/structure/taxLedger.ts'
import type { TaxEntry } from '../src/app/structure/taxLedger.ts'

const OURS = 'corp-1'
const ALLY = 'corp-2'
// An alt corp of ours: we hold a director in it, so its wallet is readable and
// its jobs are ours — but it is still a different corporation from the one that
// owns S1, which is what cost avoidance turns on.
const SISTER = 'corp-3'

// J1 and J3 ran in our structure S1, J2 in an alliance-mate's S2, J4 in the
// sister corp's own S3. J1 and J4 are personal jobs of our characters; J2 is a
// personal job of a character in the sister corp; J3 belongs to somebody else
// entirely (it resolves to a structure but to no character of ours).
const input = {
  structureByJob: new Map([
    ['J1', 'S1'],
    ['J2', 'S2'],
    ['J3', 'S1'],
    ['J4', 'S3'],
  ]),
  personalJobCorp: new Map([
    ['J1', OURS],
    ['J2', SISTER],
    ['J4', SISTER],
  ]),
  structureOwner: new Map([
    ['S1', OURS],
    ['S2', ALLY],
    ['S3', SISTER],
  ]),
  listedOwners: new Set([OURS, ALLY, SISTER]),
}

// A corporation with no structure on this page — a public station somewhere we
// rent slots in.
const LANDLORD = 'corp-9'

const entry = (over: Partial<TaxEntry>): TaxEntry => ({
  amount: 0,
  corporationId: OURS,
  jobIds: [],
  payerId: null,
  recipientId: null,
  ...over,
})

test('an incoming payment for our own job is revenue, tax we paid, and an own-rate receipt', () => {
  const ledger = foldTaxLedger([entry({ amount: 5_000, jobIds: ['J1'] })], input)
  assert.deepEqual([...ledger.revenueByStructure], [['S1', 5_000]])
  // The member's wallet paid it and no character journal exists to read, so
  // this receipt is the only record of the charge.
  assert.deepEqual([...ledger.taxesPaidByStructure], [['S1', 5_000]])
  assert.deepEqual(ledger.ownReceipts, [{ structureId: 'S1', amount: 5_000 }])
})

test("a sister corp's character paying into our structure is revenue and tax paid, never avoidance", () => {
  // J4's installer is in SISTER, which owns S3 — so in its own corp's structure
  // it does avoid. The point of the pair below is the corp/owner comparison,
  // not who we are.
  const own = foldTaxLedger([entry({ amount: 4_000, corporationId: SISTER, jobIds: ['J4'] })], input)
  assert.deepEqual(own.ownReceipts, [{ structureId: 'S3', amount: 4_000 }])

  // J2's installer is in SISTER but S2 belongs to an ally: billed at whatever
  // rate a stranger gets, so there is no own-rate receipt to scale.
  const rented = foldTaxLedger([entry({ amount: 4_000, jobIds: ['J2'] })], input)
  assert.deepEqual([...rented.revenueByStructure], [['S2', 4_000]])
  assert.deepEqual([...rented.taxesPaidByStructure], [['S2', 4_000]])
  assert.deepEqual(rented.ownReceipts, [])
})

test('an incoming payment for a CORP job is revenue only — its own wallet records the payment', () => {
  // J3 is in no personalJobCorp entry, so nothing here bills it a second time.
  const ledger = foldTaxLedger([entry({ amount: 7_000, jobIds: ['J3'] })], input)
  assert.deepEqual([...ledger.revenueByStructure], [['S1', 7_000]])
  assert.equal(ledger.taxesPaidByStructure.size, 0)
})

test("tax paid into an ally's structure is counted as paid, on their tile", () => {
  const ledger = foldTaxLedger([entry({ amount: -3_500, jobIds: ['J2'] })], input)
  assert.deepEqual([...ledger.taxesPaidByStructure], [['S2', 3_500]])
  assert.equal(ledger.revenueByStructure.size, 0)
  assert.deepEqual(ledger.ownReceipts, [])
})

test('a job we cannot place on the page is never billed to a structure', () => {
  const ledger = foldTaxLedger([entry({ amount: -3_500, jobIds: ['off-page'], recipientId: LANDLORD })], input)
  assert.equal(ledger.taxesPaidByStructure.size, 0)
  assert.equal(ledger.unaccounted, 0)
})

test('tax paid to a corporation with no tile here is totalled separately, by landlord', () => {
  const ledger = foldTaxLedger(
    [
      entry({ amount: -3_500, jobIds: ['J9'], recipientId: LANDLORD }),
      entry({ amount: -1_500, jobIds: ['J10'], recipientId: LANDLORD }),
    ],
    input
  )
  assert.deepEqual(ledger.unlistedPayments, [
    { corporationId: LANDLORD, jobId: 'J9', amount: 3_500 },
    { corporationId: LANDLORD, jobId: 'J10', amount: 1_500 },
  ])
  // Never double-billed: it is not on a tile, and not in the revenue bucket.
  assert.equal(ledger.taxesPaidByStructure.size, 0)
  assert.equal(ledger.unaccounted, 0)
})

test('the recipient is known even when the job is not, so the total stays honest', () => {
  const ledger = foldTaxLedger([entry({ amount: -900, jobIds: [], recipientId: LANDLORD })], input)
  assert.deepEqual(ledger.unlistedPayments, [{ corporationId: LANDLORD, jobId: null, amount: 900 }])
})

test('an unresolved charge to a corporation that DOES own a tile is dropped, not called elsewhere', () => {
  // Its landlord is listed, so the ISK belongs to some tile here — we just
  // can't say which. Reporting it as paid elsewhere would name the wrong corp.
  const ledger = foldTaxLedger([entry({ amount: -900, jobIds: ['off-page'], recipientId: ALLY })], input)
  assert.deepEqual(ledger.unlistedPayments, [])
  assert.equal(ledger.taxesPaidByStructure.size, 0)
})

test('a charge we can place on a tile never also counts as paid elsewhere', () => {
  const ledger = foldTaxLedger([entry({ amount: -9_007, jobIds: ['J2'], recipientId: LANDLORD })], input)
  assert.deepEqual([...ledger.taxesPaidByStructure], [['S2', 9_007]])
  assert.deepEqual(ledger.unlistedPayments, [])
})

test("a renter's payment is revenue but not ours to have avoided", () => {
  const ledger = foldTaxLedger([entry({ amount: 5_000, jobIds: ['J3'] })], input)
  assert.deepEqual([...ledger.revenueByStructure], [['S1', 5_000]])
  assert.deepEqual(ledger.ownReceipts, [])
})

test('tax our corp paid itself is an own-rate receipt and tax paid, and is never revenue', () => {
  const ledger = foldTaxLedger([entry({ amount: -9_007, jobIds: ['J1'] })], input)
  assert.deepEqual(ledger.ownReceipts, [{ structureId: 'S1', amount: 9_007 }])
  assert.deepEqual([...ledger.taxesPaidByStructure], [['S1', 9_007]])
  assert.equal(ledger.revenueByStructure.size, 0)
  assert.equal(ledger.unaccounted, 0)
})

test("tax paid into somebody else's structure is an expense, not revenue and not avoided", () => {
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
  // A job is charged its facility tax once, so it is billed to Taxes Paid once.
  assert.deepEqual([...ledger.taxesPaidByStructure], [['S1', 5_000]])
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

test('receipts and payments accumulate per structure across many entries', () => {
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
  // Every outgoing charge is tax we paid, including the one to the ally.
  assert.deepEqual(
    [...ledger.taxesPaidByStructure],
    [
      ['S1', 91_256],
      ['S2', 3_487],
    ]
  )
})
