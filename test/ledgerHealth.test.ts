// The /ledger/health fold (src/ledger/health.ts): spans, exact gaps, the
// newest check, failing wallets first.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { type CheckRow, type SegmentRow, walletHealth } from '../src/ledger/health.ts'

const seg = (key: string, first: number, last: number, opening: string, closing: string, rows: number): SegmentRow => ({
  wallet_key: key,
  registration_id: key,
  corporation_id: null,
  division: null,
  first_entry_id: first,
  last_entry_id: last,
  first_date: `2026-01-0${first}T00:00:00Z`,
  last_date: `2026-01-0${last}T00:00:00Z`,
  opening,
  closing,
  row_count: rows,
  rounding_steps: 1,
})

const check = (key: string, at: string, ok: boolean): CheckRow => ({
  wallet_key: key,
  registration_id: key,
  corporation_id: null,
  division: null,
  checked_at: at,
  ok,
  segments: 1,
  new_breaks: ok ? 0 : 1,
  snapshot_compare: 'equal',
  snapshot_difference: '0.00',
  last_pull_at: at,
  reasons: [],
})

test('a gap carries the exact ISK it is missing', () => {
  const [w] = walletHealth([seg('a', 4, 5, '190.00', '205.00', 2), seg('a', 1, 2, '0.00', '150.00', 2)], [])
  assert.deepEqual(
    w.segments.map((s) => s.first_entry_id),
    [1, 4]
  )
  assert.deepEqual(w.gaps, [
    { afterEntryId: 2, atEntryId: 4, from: '2026-01-02T00:00:00Z', to: '2026-01-04T00:00:00Z', missing: '40.00' },
  ])
  assert.equal(w.rows, 4)
  assert.equal(w.roundingSteps, 2)
  assert.equal(w.latest, null)
})

test('the newest check wins, and failing wallets come first', () => {
  const wallets = walletHealth(
    [seg('a', 1, 2, '0', '1', 2), seg('b', 1, 2, '0', '1', 2)],
    [
      check('a', '2026-01-01T00:00:00Z', false),
      check('a', '2026-01-02T00:00:00Z', true),
      check('b', '2026-01-02T00:00:00Z', false),
    ]
  )
  assert.deepEqual(
    wallets.map((w) => [w.walletKey, w.latest?.ok]),
    [
      ['b', false],
      ['a', true],
    ]
  )
})

test('a wallet with checks but no segment still shows', () => {
  const [w] = walletHealth([], [check('c', '2026-01-02T00:00:00Z', true)])
  assert.equal(w.walletKey, 'c')
  assert.deepEqual(w.gaps, [])
})
