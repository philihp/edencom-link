// Unit coverage for the /account/registrations "show grants that change
// things" filter: columns flagged `changes` drop out unless asked for, and the
// cookie that remembers the choice reads '1' as on and anything else as off.
import assert from 'node:assert/strict'
import test from 'node:test'

import { visibleGrantColumns, visibleJobColumns } from '../src/app/account/registrations/changeColumns.ts'
import { GRANT_COLUMNS } from '../src/app/account/registrations/matrix.ts'
import { parseShowChanges } from '../src/app/account/registrations/registrationsShowChanges.ts'

const JOBS = [
  { job: 'character-assets', scopes: ['a'] },
  { job: 'character-mail', scopes: ['r', 's'], changes: true },
  { job: 'character-orders', scopes: ['o'], changes: false },
]

test('visibleJobColumns hides changes columns by default, keeping order', () => {
  assert.deepEqual(
    visibleJobColumns(JOBS, false).map((e) => e.job),
    ['character-assets', 'character-orders']
  )
})

test('visibleJobColumns shows every column when asked', () => {
  assert.deepEqual(
    visibleJobColumns(JOBS, true).map((e) => e.job),
    ['character-assets', 'character-mail', 'character-orders']
  )
})

test('visibleJobColumns returns a fresh array, never the input', () => {
  assert.notEqual(visibleJobColumns(JOBS, true), JOBS)
})

test('visibleGrantColumns: save/delete fits is a changes column', () => {
  assert.deepEqual(
    visibleGrantColumns(GRANT_COLUMNS, false).map((c) => c.key),
    []
  )
  assert.deepEqual(
    visibleGrantColumns(GRANT_COLUMNS, true).map((c) => c.key),
    ['fittings-write']
  )
})

test('parseShowChanges: only "1" shows', () => {
  assert.equal(parseShowChanges('1'), true)
  assert.equal(parseShowChanges('0'), false)
  assert.equal(parseShowChanges(''), false)
  assert.equal(parseShowChanges('true'), false)
  assert.equal(parseShowChanges(undefined), false)
})
