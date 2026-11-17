// The balance chain (src/ledger/chain.ts): the proof that a wallet journal is
// complete, docs/ledger/plan.md invariant I-2. The cases mirror
// test/sql/ledger_census.sql, so the TypeScript fold and the census SQL agree.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { chainHoldShare, chainOf, type JournalRow } from '../src/ledger/chain.ts'
import { formatCents, toCents } from '../src/ledger/money.ts'

const row = (entryId: number, amount: JournalRow['amount'], balance: JournalRow['balance']): JournalRow => ({
  entryId,
  date: `2026-01-01T00:00:${String(entryId).padStart(2, '0')}Z`,
  amount,
  balance,
})

test('toCents reads numbers and strings exactly', () => {
  assert.equal(toCents('123.4'), 12340n)
  assert.equal(toCents(-0.5), -50n)
  assert.equal(toCents('7'), 700n)
  assert.equal(toCents(0.1 + 0.2), 30n)
  assert.equal(toCents('98765432109876.54'), 9876543210987654n)
  assert.equal(toCents(null), null)
  assert.equal(toCents(undefined), null)
  assert.equal(toCents(''), null)
  assert.throws(() => toCents('1.234'), /not an ISK amount/)
  assert.throws(() => toCents('abc'), /not an ISK amount/)
})

test('formatCents is the inverse of toCents', () => {
  assert.equal(formatCents(12340n), '123.40')
  assert.equal(formatCents(-5n), '-0.05')
  assert.equal(formatCents(toCents('-1000000.01') as bigint), '-1000000.01')
})

test('a complete journal is one segment', () => {
  const chain = chainOf([row(1, 100, 100), row(2, '-30.25', '69.75'), row(3, 0.25, 70)])
  assert.deepEqual(chain.breaks, [])
  assert.equal(chain.segments.length, 1)
  assert.deepEqual(
    { opening: chain.segments[0].opening, closing: chain.segments[0].closing, rows: chain.segments[0].rows },
    { opening: 0n, closing: 7000n, rows: 3 }
  )
  assert.equal(chainHoldShare(chain), 1)
})

test('the order of the input does not matter: rows are chained by entry id', () => {
  const rows = [row(3, 0.25, 70), row(1, 100, 100), row(2, '-30.25', '69.75')]
  assert.deepEqual(chainOf(rows), chainOf([...rows].reverse()))
  assert.equal(chainOf(rows).segments.length, 1)
})

test('a gap breaks the chain and says how much ISK is missing', () => {
  const chain = chainOf([row(10, 100, 100), row(11, 50, 150), row(12, 20, 170), row(14, 10, 200)])
  assert.deepEqual(chain.breaks, [{ kind: 'mismatch', afterEntryId: 12, atEntryId: 14, missing: 2000n }])
  assert.deepEqual(
    chain.segments.map((s) => [s.firstEntryId, s.lastEntryId, s.opening, s.closing]),
    [
      [10, 12, 0n, 17000n],
      [14, 14, 19000n, 20000n],
    ]
  )
  assert.equal(chainHoldShare(chain), 2 / 3)
})

test('a row with no amount or balance belongs to no segment and is not a mismatch', () => {
  const chain = chainOf([row(14, 10, 200), row(15, null, null), row(16, 5, 205)])
  assert.deepEqual(chain.breaks, [{ kind: 'unchainable', atEntryId: 15 }])
  assert.deepEqual(
    chain.segments.map((s) => [s.firstEntryId, s.lastEntryId]),
    [
      [14, 14],
      [16, 16],
    ]
  )
  assert.equal(chainHoldShare(chain), 1)
})

test('a cent off is a break', () => {
  const chain = chainOf([row(1, 100, 100), row(2, 1, '101.01')])
  assert.deepEqual(chain.breaks, [{ kind: 'mismatch', afterEntryId: 1, atEntryId: 2, missing: 1n }])
})

test('an empty wallet has no segments and nothing to disprove', () => {
  assert.deepEqual(chainOf([]), { segments: [], breaks: [] })
  assert.equal(chainHoldShare(chainOf([])), 1)
})
