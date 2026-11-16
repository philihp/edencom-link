// The fold behind /structure/rebates: facility tax each payer gave our
// structures, beside the ISK-only "tax refund" contracts we gave back.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  foldRebates,
  isIskOnlyPayment,
  isTaxRefundTitle,
  type RebateContract,
  rebateContracts,
} from '../src/app/structure/rebates/rebates.ts'

const OURS = { characterIds: new Set(['100']), corporationIds: new Set(['900']) }
const SINCE = '2026-11-01T00:00:00Z'
const NOW = '2026-11-16T00:00:00Z'

const contract = (over: Partial<RebateContract> = {}): RebateContract => ({
  contract_id: 1,
  type: 'item_exchange',
  for_corporation: false,
  issuer_id: 100,
  issuer_corporation_id: 900,
  assignee_id: 7,
  acceptor_id: 7,
  price: 0,
  reward: 1_000_000,
  title: 'Tax refund',
  status: 'finished',
  date_issued: '2026-11-05T00:00:00Z',
  date_expired: '2026-11-19T00:00:00Z',
  date_completed: '2026-11-06T00:00:00Z',
  ...over,
})

test('a title must name tax and a refund or rebate', () => {
  assert.equal(isTaxRefundTitle('Tax refund'), true)
  assert.equal(isTaxRefundTitle('industry TAX REBATE oct'), true)
  assert.equal(isTaxRefundTitle('refund of taxes'), true)
  assert.equal(isTaxRefundTitle('refund'), false)
  assert.equal(isTaxRefundTitle('tax'), false)
  assert.equal(isTaxRefundTitle(null), false)
})

test('only an item exchange paying ISK with no price and no items is a payment', () => {
  assert.equal(isIskOnlyPayment(contract(), 0), true)
  assert.equal(isIskOnlyPayment(contract(), 1), false)
  assert.equal(isIskOnlyPayment(contract({ price: 5 }), 0), false)
  assert.equal(isIskOnlyPayment(contract({ reward: 0 }), 0), false)
  assert.equal(isIskOnlyPayment(contract({ type: 'courier' }), 0), false)
})

test('a rebate must be issued by us, and each contract counts once', () => {
  const base = { itemCounts: new Map<string, number>(), ours: OURS, since: SINCE, now: NOW }
  assert.equal(rebateContracts({ ...base, contracts: [contract(), contract()] }).length, 1)
  assert.equal(rebateContracts({ ...base, contracts: [contract({ issuer_id: 555 })] }).length, 0)
  // Issued by someone else on behalf of our corporation still counts.
  assert.equal(rebateContracts({ ...base, contracts: [contract({ issuer_id: 555, for_corporation: true })] }).length, 1)
})

test('folds paid tax and rebates per payer, inside the window', () => {
  const rows = foldRebates({
    receipts: [
      { first_party_id: 7, context_id: 11, amount: 3_000_000, date: '2026-11-02T00:00:00Z' },
      { first_party_id: 7, context_id: 12, amount: 2_000_000, date: '2026-11-03T00:00:00Z' },
      { first_party_id: 7, context_id: 13, amount: 9_000_000, date: '2026-10-01T00:00:00Z' }, // before the window
      { first_party_id: 8, context_id: 21, amount: 4_000_000, date: '2026-11-04T00:00:00Z' },
      { first_party_id: 8, context_id: 22, amount: -4_000_000, date: '2026-11-04T00:00:00Z' }, // outgoing, not a receipt
    ],
    contracts: [
      contract({ contract_id: 1 }),
      contract({ contract_id: 2, date_completed: '2026-10-02T00:00:00Z' }), // completed before the window
      contract({ contract_id: 3, status: 'outstanding', acceptor_id: null, reward: 500_000 }),
      contract({ contract_id: 4, status: 'outstanding', acceptor_id: null, date_expired: '2026-11-10T00:00:00Z' }), // expired
      contract({ contract_id: 5, title: 'gift', acceptor_id: 8 }), // not a tax refund
    ],
    itemCounts: new Map(),
    ours: OURS,
    since: SINCE,
    now: NOW,
  })
  assert.deepEqual(rows, [
    { partyId: '7', paid: 5_000_000, jobs: 2, rebated: 1_000_000, rebates: 1, pending: 500_000, net: 4_000_000 },
    { partyId: '8', paid: 4_000_000, jobs: 1, rebated: 0, rebates: 0, pending: 0, net: 4_000_000 },
  ])
})

test('a payer with nothing in the window is left out', () => {
  const rows = foldRebates({
    receipts: [{ first_party_id: 7, context_id: 1, amount: 1, date: '2026-10-01T00:00:00Z' }],
    contracts: [],
    itemCounts: new Map(),
    ours: OURS,
    since: SINCE,
    now: NOW,
  })
  assert.deepEqual(rows, [])
})
