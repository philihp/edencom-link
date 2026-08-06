// Unit coverage for the two decisions behind update_lens over MCP: which lens
// an edit is aimed at, and which columns it touches.
//
// Both are places where being approximately right is worse than refusing — the
// first overwrites a saved query, the second decides whether "rename it" also
// rewrites it. The picker's refusals are pinned here; the same matcher backs
// the audience resolver, so test/lensAudience.test.ts covers it from the other
// side.
import assert from 'node:assert/strict'
import test from 'node:test'

import { lensEdits, resolveLensRef } from '../src/app/lens/lensRef.ts'

const LENSES = [
  { id: '11111111-1111-4111-8111-111111111111', name: 'Fuel block inputs' },
  { id: '22222222-2222-4222-8222-222222222222', name: 'Fuel block outputs' },
  { id: '33333333-3333-4333-8333-333333333333', name: 'Capital rigs' },
]

const pickedId = (result: ReturnType<typeof resolveLensRef>) => {
  assert.equal(result.ok, true, result.ok ? '' : result.message)
  return result.ok ? result.id : (assert.fail('unreachable') as never)
}

const refusal = (result: ReturnType<typeof resolveLensRef>) => {
  assert.equal(result.ok, false)
  return result.ok ? (assert.fail('unreachable') as never) : result.message
}

test('a lens resolves by id, by exact name, and by a name only one carries', () => {
  assert.equal(pickedId(resolveLensRef(LENSES[2].id, LENSES)), LENSES[2].id)
  assert.equal(pickedId(resolveLensRef('Fuel block inputs', LENSES)), LENSES[0].id)
  assert.equal(pickedId(resolveLensRef('capital', LENSES)), LENSES[2].id)
})

test('a reference matching two lenses is refused rather than guessed', () => {
  const message = refusal(resolveLensRef('fuel block', LENSES))
  assert.match(message, /matches more than one lens/)
  assert.match(message, /Fuel block inputs/)
  assert.match(message, /Fuel block outputs/)
})

test('a reference matching nothing lists what there is', () => {
  assert.match(refusal(resolveLensRef('mining ledger', LENSES)), /not one of your lenss?\./)
  assert.match(refusal(resolveLensRef('mining ledger', LENSES)), /Capital rigs/)
})

test('an empty reference is refused', () => {
  assert.match(refusal(resolveLensRef('   ', LENSES)), /empty/)
})

const STORED = { query: 'query { walletBalances { ownerName balance } }', variables: { a: 1 } }

test('an edit touches only what it names', () => {
  const renamed = lensEdits({ name: 'Wallets' }, STORED)
  assert.deepEqual(renamed.changes, { name: 'Wallets' })
  assert.deepEqual(renamed.changed, ['name'])
  // The query is unchanged, and is still what gets previewed.
  assert.equal(renamed.effective.query, STORED.query)
  assert.deepEqual(renamed.effective.variables, STORED.variables)
})

test('an edit with nothing in it changes nothing', () => {
  const untouched = lensEdits({}, STORED)
  assert.deepEqual(untouched.changes, {})
  assert.deepEqual(untouched.changed, [])
  assert.equal(untouched.effective.query, STORED.query)
})

test('a new query is what gets previewed, against the stored variables', () => {
  const rewritten = lensEdits({ query: 'query { owners { id name } }' }, STORED)
  assert.deepEqual(rewritten.changed, ['query'])
  assert.equal(rewritten.effective.query, 'query { owners { id name } }')
  assert.deepEqual(rewritten.effective.variables, STORED.variables)
})

test('variables are replaced wholesale, never merged', () => {
  const revaried = lensEdits({ variables: { b: 2 } }, STORED)
  assert.deepEqual(revaried.changes.variables, { b: 2 })
  assert.deepEqual(revaried.effective.variables, { b: 2 })
})

test('emptying the variables is a real edit, not a no-op', () => {
  const cleared = lensEdits({ variables: {} }, STORED)
  assert.deepEqual(cleared.changed, ['variables'])
  assert.deepEqual(cleared.effective.variables, {})
})

test('a blank name is dropped rather than saved', () => {
  assert.deepEqual(lensEdits({ name: '   ' }, STORED).changed, [])
})

test('a name is trimmed on the way in', () => {
  assert.equal(lensEdits({ name: '  Wallets  ' }, STORED).changes.name, 'Wallets')
})
