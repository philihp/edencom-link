// Save-time validation for Lens queries (src/app/lens/validate.ts): parse +
// schema validation, the single-top-level-field rule that keeps the CSV
// rendering unambiguous, and the session-only denylist.
import assert from 'node:assert/strict'
import test from 'node:test'

import { parseLensVariables, validateLensQuery } from '../src/app/lens/validate.ts'

test('a plain single-field query passes', () => {
  const result = validateLensQuery(`{ walletBalances { ownerName balance } }`)
  assert.deepEqual(result, { ok: true })
})

test('a named query with variables passes', () => {
  const result = validateLensQuery(`query Stockpile($item: String!) {
    assets(typeName: $item) { totalCount rows { typeName quantity } }
  }`)
  assert.deepEqual(result, { ok: true })
})

test('syntax errors are rejected with a parse message', () => {
  const result = validateLensQuery(`{ walletBalances {`)
  assert.equal(result.ok, false)
  assert.match((result as { message: string }).message, /does not parse/)
})

test('unknown fields fail schema validation', () => {
  const result = validateLensQuery(`{ walletHistory { balance } }`)
  assert.equal(result.ok, false)
  assert.match((result as { message: string }).message, /not valid against the schema/)
})

test('two top-level fields are rejected', () => {
  const result = validateLensQuery(`{
    walletBalances { balance }
    marketOrders { price }
  }`)
  assert.equal(result.ok, false)
  assert.match((result as { message: string }).message, /exactly one top-level field/)
})

test('multiple operations are rejected', () => {
  const result = validateLensQuery(`query A { walletBalances { balance } } query B { marketOrders { price } }`)
  assert.equal(result.ok, false)
  assert.match((result as { message: string }).message, /exactly one operation/)
})

test('the session-only sharedWithMe field is rejected', () => {
  const result = validateLensQuery(`{ sharedWithMe { itemId ownerName } }`)
  assert.equal(result.ok, false)
  assert.match((result as { message: string }).message, /session-only/)
})

test('the session-only includeShared argument is rejected', () => {
  const result = validateLensQuery(`{ assets(includeShared: true) { rows { typeName } } }`)
  assert.equal(result.ok, false)
  assert.match((result as { message: string }).message, /session-only/)
})

test('variables parse to an object, empty string to {}', () => {
  assert.deepEqual(parseLensVariables(''), { ok: true, variables: {} })
  assert.deepEqual(parseLensVariables('  { "item": "Tritanium" } '), { ok: true, variables: { item: 'Tritanium' } })
})

test('non-object variables are rejected', () => {
  assert.equal(parseLensVariables('[1, 2]').ok, false)
  assert.equal(parseLensVariables('"x"').ok, false)
  assert.equal(parseLensVariables('not json').ok, false)
})
