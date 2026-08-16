// Unit coverage for the two decisions behind update_link over MCP: which link
// an edit is aimed at, and which columns it touches.
//
// Both are places where being approximately right is worse than refusing — the
// first overwrites a saved query, the second decides whether "rename it" also
// rewrites it. The picker's refusals are pinned here; the same matcher backs
// the audience resolver, so test/linkAudience.test.ts covers it from the other
// side.
import assert from 'node:assert/strict'
import test from 'node:test'

import { linkEdits, resolveLinkRef } from '../src/app/link/linkRef.ts'

const LINKS = [
  { id: '11111111-1111-4111-8111-111111111111', name: 'Fuel block inputs' },
  { id: '22222222-2222-4222-8222-222222222222', name: 'Fuel block outputs' },
  { id: '33333333-3333-4333-8333-333333333333', name: 'Capital rigs' },
]

const pickedId = (result: ReturnType<typeof resolveLinkRef>) => {
  assert.equal(result.ok, true, result.ok ? '' : result.message)
  return result.ok ? result.id : (assert.fail('unreachable') as never)
}

const refusal = (result: ReturnType<typeof resolveLinkRef>) => {
  assert.equal(result.ok, false)
  return result.ok ? (assert.fail('unreachable') as never) : result.message
}

test('a link resolves by id, by exact name, and by a name only one carries', () => {
  assert.equal(pickedId(resolveLinkRef(LINKS[2].id, LINKS)), LINKS[2].id)
  assert.equal(pickedId(resolveLinkRef('Fuel block inputs', LINKS)), LINKS[0].id)
  assert.equal(pickedId(resolveLinkRef('capital', LINKS)), LINKS[2].id)
})

test('a reference matching two links is refused rather than guessed', () => {
  const message = refusal(resolveLinkRef('fuel block', LINKS))
  assert.match(message, /matches more than one link/)
  assert.match(message, /Fuel block inputs/)
  assert.match(message, /Fuel block outputs/)
})

test('a reference matching nothing lists what there is', () => {
  assert.match(refusal(resolveLinkRef('mining ledger', LINKS)), /not one of your links?\./)
  assert.match(refusal(resolveLinkRef('mining ledger', LINKS)), /Capital rigs/)
})

test('an empty reference is refused', () => {
  assert.match(refusal(resolveLinkRef('   ', LINKS)), /empty/)
})

const STORED = { query: 'query { walletBalances { ownerName balance } }', variables: { a: 1 } }

test('an edit touches only what it names', () => {
  const renamed = linkEdits({ name: 'Wallets' }, STORED)
  assert.deepEqual(renamed.changes, { name: 'Wallets' })
  assert.deepEqual(renamed.changed, ['name'])
  // The query is unchanged, and is still what gets previewed.
  assert.equal(renamed.effective.query, STORED.query)
  assert.deepEqual(renamed.effective.variables, STORED.variables)
})

test('an edit with nothing in it changes nothing', () => {
  const untouched = linkEdits({}, STORED)
  assert.deepEqual(untouched.changes, {})
  assert.deepEqual(untouched.changed, [])
  assert.equal(untouched.effective.query, STORED.query)
})

test('a new query is what gets previewed, against the stored variables', () => {
  const rewritten = linkEdits({ query: 'query { owners { id name } }' }, STORED)
  assert.deepEqual(rewritten.changed, ['query'])
  assert.equal(rewritten.effective.query, 'query { owners { id name } }')
  assert.deepEqual(rewritten.effective.variables, STORED.variables)
})

test('variables are replaced wholesale, never merged', () => {
  const revaried = linkEdits({ variables: { b: 2 } }, STORED)
  assert.deepEqual(revaried.changes.variables, { b: 2 })
  assert.deepEqual(revaried.effective.variables, { b: 2 })
})

test('emptying the variables is a real edit, not a no-op', () => {
  const cleared = linkEdits({ variables: {} }, STORED)
  assert.deepEqual(cleared.changed, ['variables'])
  assert.deepEqual(cleared.effective.variables, {})
})

test('a blank name is dropped rather than saved', () => {
  assert.deepEqual(linkEdits({ name: '   ' }, STORED).changed, [])
})

test('a name is trimmed on the way in', () => {
  assert.equal(linkEdits({ name: '  Wallets  ' }, STORED).changes.name, 'Wallets')
})
