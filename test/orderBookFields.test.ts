// The market-depth job's row mapper (src/jobs/orderBookFields.js).
import assert from 'node:assert/strict'
import test from 'node:test'

import { JITA_44, toBookRows } from '../src/jobs/orderBookFields.js'

const order = (over: Record<string, unknown>) => ({
  order_id: 1,
  type_id: 30375,
  location_id: JITA_44,
  price: 1000,
  volume_remain: 50,
  issued: '2026-11-10T00:00:00Z',
  is_buy_order: false,
  ...over,
})

test('keeps only the sell orders at the station', () => {
  const rows = toBookRows(
    'jita',
    JITA_44,
    '2026-11-10T01:00:00Z'
  )([order({}), order({ order_id: 2, is_buy_order: true }), order({ order_id: 3, location_id: 60000001 })])
  assert.deepEqual(rows, [
    {
      market: 'jita',
      order_id: 1,
      type_id: 30375,
      location_id: JITA_44,
      price: 1000,
      volume_remain: 50,
      issued: '2026-11-10T00:00:00Z',
      captured_at: '2026-11-10T01:00:00Z',
    },
  ])
})
