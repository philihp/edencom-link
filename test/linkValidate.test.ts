// Save-time validation for Link queries (src/app/link/validate.ts): parse +
// schema validation, the single-top-level-field rule that keeps the CSV
// rendering unambiguous, and the session-only denylist.
import assert from 'node:assert/strict'
import test from 'node:test'

import { parseLinkVariables, topLevelFieldOf, validateLinkQuery } from '../src/app/link/validate.ts'

test('a plain single-field query passes', () => {
  const result = validateLinkQuery(`{ walletBalances { ownerName balance } }`)
  assert.deepEqual(result, { ok: true })
})

test('a named query with variables passes', () => {
  const result = validateLinkQuery(`query Stockpile($item: String!) {
    assets(type: $item) { totalCount rows { typeName quantity } }
  }`)
  assert.deepEqual(result, { ok: true })
})

test('syntax errors are rejected with a parse message', () => {
  const result = validateLinkQuery(`{ walletBalances {`)
  assert.equal(result.ok, false)
  assert.match((result as { message: string }).message, /does not parse/)
})

test('unknown fields fail schema validation', () => {
  const result = validateLinkQuery(`{ walletHistory { balance } }`)
  assert.equal(result.ok, false)
  assert.match((result as { message: string }).message, /not valid against the schema/)
})

test('two top-level fields are rejected', () => {
  const result = validateLinkQuery(`{
    walletBalances { balance }
    marketOrders { price }
  }`)
  assert.equal(result.ok, false)
  assert.match((result as { message: string }).message, /exactly one top-level field/)
})

test('multiple operations are rejected', () => {
  const result = validateLinkQuery(`query A { walletBalances { balance } } query B { marketOrders { price } }`)
  assert.equal(result.ok, false)
  assert.match((result as { message: string }).message, /exactly one operation/)
})

test('the session-only sharedWithMe field is rejected', () => {
  const result = validateLinkQuery(`{ sharedWithMe { itemId ownerName } }`)
  assert.equal(result.ok, false)
  assert.match((result as { message: string }).message, /session-only/)
})

test('the session-only includeShared argument is rejected', () => {
  const result = validateLinkQuery(`{ assets(includeShared: true) { rows { typeName } } }`)
  assert.equal(result.ok, false)
  assert.match((result as { message: string }).message, /session-only/)
})

test('variables parse to an object, empty string to {}', () => {
  assert.deepEqual(parseLinkVariables(''), { ok: true, variables: {} })
  assert.deepEqual(parseLinkVariables('  { "item": "Tritanium" } '), { ok: true, variables: { item: 'Tritanium' } })
})

test('non-object variables are rejected', () => {
  assert.equal(parseLinkVariables('[1, 2]').ok, false)
  assert.equal(parseLinkVariables('"x"').ok, false)
  assert.equal(parseLinkVariables('not json').ok, false)
})

test('topLevelFieldOf names the single root field of a saved link', () => {
  assert.equal(topLevelFieldOf(`{ walletBalances { balance } }`), 'walletBalances')
  assert.equal(
    topLevelFieldOf(`query Stockpile($item: String!) { assets(type: $item) { rows { quantity } } }`),
    'assets'
  )
})

test('topLevelFieldOf answers null rather than throwing on anything unnamed', () => {
  assert.equal(topLevelFieldOf(`{ walletBalances {`), null)
  assert.equal(topLevelFieldOf(``), null)
})
