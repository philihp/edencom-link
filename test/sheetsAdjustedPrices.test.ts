// Unit coverage for the /sheets/adjusted-prices CSV: its columns are what the
// sheet's VLOOKUP reads by position, and an empty table must still be a table.
import assert from 'node:assert/strict'
import test from 'node:test'

import { adjustedPriceCsv, HEADER } from '../src/app/sheets/adjusted-prices/adjustedPrices.ts'

test('adjustedPriceCsv puts TypeID first and AdjustedPrice second', () => {
  const csv = adjustedPriceCsv([
    { type_id: 34, adjusted_price: 4.12, average_price: 3.9, recorded_at: '2026-09-23T11:52:00+00:00' },
  ])
  assert.equal(csv, `${HEADER}\r\n34,4.12,3.9,2026-09-23T11:52:00+00:00`)
})

test('a missing average price is empty, never 0', () => {
  const csv = adjustedPriceCsv([
    { type_id: 35, adjusted_price: 10, average_price: null, recorded_at: '2026-09-23T11:52:00+00:00' },
  ])
  assert.equal(csv.split('\r\n')[1], '35,10,,2026-09-23T11:52:00+00:00')
})

test('an empty table answers the header alone', () => {
  assert.equal(adjustedPriceCsv([]), HEADER)
})
