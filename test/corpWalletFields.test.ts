// The corporation wallet balance pull (src/jobs/corpWalletFields.js, ledger
// stage 1): ESI's answer → corp_wallet rows, with bad entries dropped.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { toWalletRows } from '../src/jobs/corpWalletFields.js'

test('each division becomes one row', () => {
  assert.deepEqual(
    toWalletRows(98000001, [
      { division: 1, balance: 1234.56 },
      { division: 7, balance: 0 },
    ]),
    [
      { corporation_id: 98000001, division: 1, balance: 1234.56 },
      { corporation_id: 98000001, division: 7, balance: 0 },
    ]
  )
})

test('a bad division or balance is dropped, and a bad answer is no rows', () => {
  assert.deepEqual(
    toWalletRows(1, [
      { division: 0, balance: 1 },
      { division: 8, balance: 1 },
      { division: 2 },
      { division: 3, balance: 'x' },
      null,
    ]),
    []
  )
  assert.deepEqual(toWalletRows(1, null), [])
  assert.deepEqual(toWalletRows(1, { error: 'forbidden' }), [])
})
