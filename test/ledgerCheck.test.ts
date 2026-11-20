// The daily wallet check (src/ledger/check.ts, ledger stage 1): continuing a
// stored chain, rebuilding on late rows, what to write, the snapshot compare,
// the verdict and the row budget.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { type JournalRow, chainOf } from '../src/ledger/chain.ts'
import {
  STALE_AFTER_MS,
  compareSnapshot,
  fitsBudget,
  judgeWallet,
  needsRebuild,
  nextChain,
  segmentWrites,
  toJournalRow,
} from '../src/ledger/check.ts'

const row = (entryId: number, amount: number | string, balance: number | string): JournalRow => ({
  entryId,
  date: new Date(Date.UTC(2026, 0, 1, 0, 0, entryId)).toISOString(),
  amount,
  balance,
})

const NOW = new Date('2026-11-19T00:00:00Z')
const RECENT = '2026-11-18T12:00:00Z'

// A wallet with one gap: 1–2 chain, 4 starts again.
const history = [row(1, 100, 100), row(2, 50, 150), row(4, 10, 200)]

test('compareSnapshot: equal, one cent, differs, none', () => {
  assert.deepEqual(compareSnapshot('100.00', 100), { compare: 'equal', difference: '0.00' })
  assert.deepEqual(compareSnapshot('99.99', '100.00'), { compare: 'one_cent', difference: '-0.01' })
  assert.deepEqual(compareSnapshot(102, 100), { compare: 'differs', difference: '2.00' })
  assert.deepEqual(compareSnapshot(null, 100), { compare: 'none', difference: null })
})

test('a continued chain equals the chain built from scratch', () => {
  const stored = chainOf(history).segments
  const next = nextChain(stored, [row(5, 5, 205), row(7, 1, 300)], false)
  assert.deepEqual(next, {
    segments: chainOf([...history, row(5, 5, 205), row(7, 1, 300)]).segments,
    breaks: [{ kind: 'mismatch', afterEntryId: 5, atEntryId: 7, missing: 9400n }],
  })
})

test('only new and changed segments are written', () => {
  const stored = chainOf(history).segments
  const next = nextChain(stored, [row(5, 5, 205)], false)
  const writes = segmentWrites(stored, next)
  assert.deepEqual(
    writes.upsert.map((s) => [s.firstEntryId, s.lastEntryId]),
    [[4, 5]]
  )
  assert.deepEqual(writes.remove, [])
  assert.deepEqual(segmentWrites(stored, nextChain(stored, [], false)), { upsert: [], remove: [] })
})

test('late rows inside the stored span force a rebuild, which can close a gap', () => {
  const stored = chainOf(history).segments
  assert.equal(needsRebuild(stored, 3), false)
  assert.equal(needsRebuild(stored, 4), true)
  assert.equal(needsRebuild([], 10), false)
  const rebuilt = nextChain(stored, [...history, row(3, 40, 190)], true)
  assert.equal(rebuilt.segments.length, 1)
  const writes = segmentWrites(stored, rebuilt)
  assert.deepEqual(writes.remove, [4])
  assert.deepEqual(
    writes.upsert.map((s) => [s.firstEntryId, s.lastEntryId]),
    [[1, 4]]
  )
})

test('the first run is a baseline: old gaps are recorded, not raised', () => {
  const chain = chainOf(history)
  const verdict = judgeWallet({ stored: [], chain, rebuilt: false, snapshot: 'equal', lastPullAt: RECENT, now: NOW })
  assert.deepEqual(verdict, { ok: true, newBreaks: 0, reasons: [] })
})

test('a new break fails the wallet', () => {
  const stored = chainOf(history).segments
  const chain = nextChain(stored, [row(9, 1, 999)], false)
  const verdict = judgeWallet({ stored, chain, rebuilt: false, snapshot: 'none', lastPullAt: RECENT, now: NOW })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.newBreaks, 1)
  assert.match(verdict.reasons[0], /1 new break in the journal/)
})

test('rounding is not a break', () => {
  const stored = chainOf(history).segments
  const chain = nextChain(stored, [row(5, 5, '205.01')], false)
  const verdict = judgeWallet({ stored, chain, rebuilt: false, snapshot: 'one_cent', lastPullAt: RECENT, now: NOW })
  assert.deepEqual(verdict, { ok: true, newBreaks: 0, reasons: [] })
})

test('a snapshot that differs, or a stale or missing pull, fails the wallet', () => {
  const chain = chainOf(history)
  const stored = chain.segments
  const judge = (snapshot: 'differs' | 'equal', lastPullAt: string | null) =>
    judgeWallet({ stored, chain: nextChain(stored, [], false), rebuilt: false, snapshot, lastPullAt, now: NOW })
  assert.equal(judge('differs', RECENT).ok, false)
  assert.equal(judge('equal', null).ok, false)
  assert.equal(judge('equal', new Date(NOW.getTime() - STALE_AFTER_MS - 1).toISOString()).ok, false)
  assert.equal(judge('equal', new Date(NOW.getTime() - STALE_AFTER_MS + 1000).toISOString()).ok, true)
})

test('a rebuild that only closes a gap is a notice, not a failure', () => {
  const stored = chainOf(history).segments
  const chain = nextChain(stored, [...history, row(3, 40, 190)], true)
  const verdict = judgeWallet({ stored, chain, rebuilt: true, snapshot: 'equal', lastPullAt: RECENT, now: NOW })
  assert.equal(verdict.ok, true)
  assert.equal(verdict.newBreaks, 0)
  assert.equal(verdict.reasons.length, 1)
})

test('the row budget stops before a wallet that would cross it', () => {
  assert.equal(fitsBudget(0, 10, 10), true)
  assert.equal(fitsBudget(5, 6, 10), false)
})

test('a self-paid industry job tax carries its hidden credit; others do not', () => {
  const base = { entry_id: 7, date: '2026-01-01T00:00:00Z', amount: '-564681.00', balance: '100.00' }
  assert.equal(
    toJournalRow({ ...base, ref_type: 'industry_job_tax', first_party_id: 9, second_party_id: '9' }).hiddenCredit,
    '564681.00'
  )
  assert.equal(
    toJournalRow({ ...base, ref_type: 'industry_job_tax', first_party_id: 9, second_party_id: 8 }).hiddenCredit,
    undefined
  )
  assert.equal(
    toJournalRow({ ...base, ref_type: 'manufacturing', first_party_id: 9, second_party_id: 9 }).hiddenCredit,
    undefined
  )
  assert.equal(toJournalRow({ ...base, ref_type: 'industry_job_tax' }).hiddenCredit, undefined)
})
