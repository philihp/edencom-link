// The /ledger read fold (src/ledger/statement.ts), against a fixture of the
// JSON contract in docs/ledger/stage-2.md ("The statement").
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import {
  type Account,
  ledgerView,
  monthsOf,
  monthWindow,
  parseStatement,
  pickerWallets,
  scopeOf,
  windowMonths,
} from '../src/ledger/statement.ts'

const fixture: unknown = JSON.parse(readFileSync(new URL('./fixtures/ledgerStatement.json', import.meta.url), 'utf8'))

const CHART: Account[] = [
  { code: '1100', name: 'Market escrow', kind: 'asset' },
  { code: '1200', name: 'Inventory', kind: 'asset' },
  { code: '4000', name: 'Revenue: market sales', kind: 'revenue' },
  { code: '4200', name: 'Revenue: services', kind: 'revenue' },
  { code: '5100', name: 'Broker fees', kind: 'expense' },
  { code: '5110', name: 'Sales tax', kind: 'expense' },
  { code: '5210', name: 'Industry: facility tax', kind: 'expense' },
  { code: '9000', name: 'Suspense: unclassified', kind: 'equity' },
]

const statement = () => {
  const s = parseStatement(fixture)
  assert.ok(s, 'the fixture is a statement')
  return s
}

test('the fixture parses; a value off the contract does not', () => {
  statement()
  assert.equal(parseStatement(null), null)
  assert.equal(parseStatement({}), null)
  assert.equal(parseStatement({ ...(fixture as object), scope: 'everyone' }), null)
  const bad = structuredClone(fixture) as { months: { lines: { amount: string }[] }[] }
  bad.months[0].lines[0].amount = '1.234'
  assert.equal(parseStatement(bad), null)
  const reason = structuredClone(fixture) as { months: { not_proven: string[] }[] }
  reason.months[1].not_proven = ['because']
  assert.equal(parseStatement(reason), null)
})

test('a month with no rows still has a column', () => {
  const v = ledgerView(statement(), CHART)
  assert.deepEqual(v.months, ['2026-09', '2026-10', '2026-11'])
  assert.equal(v.status[0].present, false)
  assert.equal(v.status[0].proven, false)
})

test('the P&L turns the sign: income positive, cost negative', () => {
  const v = ledgerView(statement(), CHART)
  assert.deepEqual(
    v.revenue.map((r) => [r.code, r.byMonth, r.total]),
    [
      ['4000', [0n, 100000n, 0n], 100000n],
      ['4200', [0n, 0n, 20000n], 20000n],
    ]
  )
  assert.deepEqual(
    v.expense.map((r) => [r.code, r.byMonth]),
    [
      ['5100', [0n, -1000n, 0n]],
      ['5110', [0n, -4000n, 0n]],
      ['5210', [0n, 0n, -2050n]],
    ]
  )
  assert.deepEqual(v.revenueTotal, [0n, 100000n, 20000n])
  assert.deepEqual(v.expenseTotal, [0n, -5000n, -2050n])
  assert.deepEqual(v.net, [0n, 95000n, 17950n])
  assert.equal(v.netTotal, 112950n)
})

test('lines outside the P&L keep the debit sign, and cash closes the month', () => {
  const v = ledgerView(statement(), CHART)
  assert.deepEqual(
    v.other.map((r) => [r.code, r.byMonth]),
    [
      ['1100', [0n, 50000n, 0n]],
      ['1200', [0n, 0n, 10000n]],
      ['9000', [0n, -500n, 0n]],
    ]
  )
  // Cash is the negative of the sum of every other-side line.
  const s = statement()
  const raw = s.months.map((m) => -m.lines.reduce((a, l) => a + Math.round(Number(l.amount) * 100), 0))
  assert.deepEqual(v.cash, [0n, BigInt(raw[0]), BigInt(raw[1])])
  assert.deepEqual(v.cash, [0n, 45500n, 7950n])
})

test('a code the chart does not list stays out of the P&L', () => {
  const s = statement()
  const v = ledgerView(
    { ...s, months: [{ ...s.months[0], lines: [{ account_code: '4999', amount: '-7.00', rows: 1 }] }] },
    CHART
  )
  assert.deepEqual(v.revenue, [])
  assert.deepEqual(
    v.other.map((r) => [r.code, r.name, r.kind]),
    [['4999', 'Account 4999', 'unknown']]
  )
})

test('proven, its reasons, and the Suspense share', () => {
  const v = ledgerView(statement(), CHART)
  assert.equal(v.status[1].proven, true)
  assert.deepEqual(v.status[2].reasons, ['break', 'unpaired_transfer'])
  assert.equal(v.status[2].unpairedTransfers, 1)
  assert.equal(v.allProven, false)
  assert.equal(v.suspenseIsk, 500n)
  assert.equal(v.iskMoved, 188550n)
  assert.equal(v.status[1].suspenseShare, 500 / 156500)
  assert.ok(Math.abs(v.suspenseShare - 500 / 188550) < 1e-6)
  assert.deepEqual(
    v.suspense.map((r) => r.refType),
    ['unknown_big', 'unknown_small']
  )
})

test('the window is the trailing UTC months, this month included', () => {
  const now = new Date('2026-11-22T22:00:00Z')
  assert.deepEqual(monthWindow(now, 3), { from: '2026-09-01', to: '2026-12-01' })
  assert.deepEqual(monthWindow(now, 12), { from: '2025-12-01', to: '2026-12-01' })
  assert.deepEqual(monthWindow(new Date('2027-01-01T00:00:00Z'), 1), { from: '2027-01-01', to: '2027-02-01' })
  assert.deepEqual(monthsOf(monthWindow(new Date('2026-01-15T00:00:00Z'), 3)), ['2025-11', '2025-12', '2026-01'])
  // 12 months never pass the 366-day limit (C2).
  const { from, to } = monthWindow(new Date('2028-03-01T00:00:00Z'), 12)
  assert.ok((Date.parse(to) - Date.parse(from)) / 86_400_000 <= 366)
  assert.equal(windowMonths('12'), 12)
  assert.equal(windowMonths('5'), 3)
  assert.equal(windowMonths(undefined), 3)
})

test('the picker offers only wallets of the group, once each', () => {
  const r1 = '00000000-0000-4000-8000-000000000001'
  const seg = (registration_id: string | null, corporation_id: number | null, division: number | null) => ({
    wallet_key: registration_id ?? `${corporation_id}:${division}`,
    registration_id,
    corporation_id,
    division,
  })
  const wallets = pickerWallets(
    [
      { registration_id: r1, character_id: 1, corporation_id: null },
      { registration_id: null, corporation_id: 98000001 },
    ],
    [
      seg(null, 98000001, 2),
      seg(r1, null, null),
      seg(r1, null, null),
      seg(null, 98000001, 1),
      // A corporation the caller is only a member of (I-11).
      seg(null, 98000002, 1),
      seg('00000000-0000-4000-8000-000000000009', null, null),
    ]
  )
  assert.deepEqual(
    wallets.map((w) => w.wallet_key),
    [r1, '98000001:1', '98000001:2']
  )
  assert.deepEqual(scopeOf('98000001:2', wallets), { scope: 'wallet', walletKey: '98000001:2' })
  assert.deepEqual(scopeOf('98000002:1', wallets), { scope: 'group', walletKey: null })
  assert.deepEqual(scopeOf(undefined, wallets), { scope: 'group', walletKey: null })
})
