// The migration-numbering guard (.github/workflows/migration-order.yml). Its
// whole job is to fail a PR that back-dates a migration, so the comparison
// itself is the part worth testing — the git plumbing around it is a few
// ls-tree calls.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { checkMigrations } from '../.github/scripts/check-migrations.mjs'

const MERGED = ['20260723000000_sde_taxonomy_views.sql', '20260725000000_blueprint_search.sql']

test('a migration numbered after everything merged passes', () => {
  assert.deepEqual(
    checkMigrations({
      baseFiles: MERGED,
      headFiles: [...MERGED, '20260726000000_new_thing.sql'],
    }),
    []
  )
})

test('a PR that touches no migrations passes', () => {
  assert.deepEqual(checkMigrations({ baseFiles: MERGED, headFiles: MERGED }), [])
})

test('a migration numbered before one already merged fails', () => {
  const errors = checkMigrations({
    baseFiles: MERGED,
    headFiles: [...MERGED, '20260724000000_back_dated.sql'],
  })
  assert.equal(errors.length, 1)
  assert.match(errors[0], /20260724000000_back_dated\.sql/)
  assert.match(errors[0], /20260725000000/)
})

test('a migration reusing a merged version fails, naming the file it collides with', () => {
  const errors = checkMigrations({
    baseFiles: MERGED,
    headFiles: [...MERGED, '20260725000000_same_stamp.sql'],
  })
  assert.equal(errors.length, 1)
  assert.match(errors[0], /reuses version 20260725000000/)
  assert.match(errors[0], /20260725000000_blueprint_search\.sql/)
})

test('two migrations added by the same PR may not share a version', () => {
  const errors = checkMigrations({
    baseFiles: MERGED,
    headFiles: [...MERGED, '20260726000000_a.sql', '20260726000000_b.sql'],
  })
  assert.equal(errors.length, 1)
  assert.match(errors[0], /both added by this PR/)
})

test('several migrations added in one PR are fine as long as each sorts after the merged ones', () => {
  assert.deepEqual(
    checkMigrations({
      baseFiles: MERGED,
      headFiles: [...MERGED, '20260726000000_a.sql', '20260727000000_b.sql'],
    }),
    []
  )
})

test('ties that already exist on the base branch are not held against a PR', () => {
  // main really does carry two 20260723020000_* and two 20260725000000_* files.
  const tied = [...MERGED, '20260725000000_mercenary_den_alliance_sharing.sql']
  assert.deepEqual(
    checkMigrations({ baseFiles: tied, headFiles: [...tied, '20260726000000_new.sql'] }),
    []
  )
})

test('an unparseable filename fails', () => {
  const errors = checkMigrations({
    baseFiles: MERGED,
    headFiles: [...MERGED, 'add_a_column.sql'],
  })
  assert.equal(errors.length, 1)
  assert.match(errors[0], /db:new/)
})

test('renaming a migration that already merged fails', () => {
  const errors = checkMigrations({
    baseFiles: MERGED,
    headFiles: [MERGED[0], '20260726000000_blueprint_search.sql'],
  })
  // Both halves of the rename are reported: the file that vanished, and the
  // fact that a renumbered copy showed up (here, legitimately numbered).
  assert.equal(errors.length, 1)
  assert.match(errors[0], /20260725000000_blueprint_search\.sql was renamed or deleted/)
})

test('deleting a migration that already merged fails', () => {
  const errors = checkMigrations({ baseFiles: MERGED, headFiles: [MERGED[0]] })
  assert.equal(errors.length, 1)
  assert.match(errors[0], /renamed or deleted/)
})

test('a branch that is merely behind main is not accused of deleting migrations', () => {
  // main gained a migration after this branch forked; the branch's head simply
  // doesn't have it yet. That is a rebase away, not a deletion.
  const errors = checkMigrations({
    baseFiles: [...MERGED, '20260726000000_landed_meanwhile.sql'],
    headFiles: [...MERGED, '20260727000000_mine.sql'],
    forkFiles: MERGED,
  })
  assert.deepEqual(errors, [])
})

test('a stale branch is still judged against migrations that merged after it forked', () => {
  const errors = checkMigrations({
    baseFiles: [...MERGED, '20260726000000_landed_meanwhile.sql'],
    headFiles: [...MERGED, '20260725500000_mine.sql'],
    forkFiles: MERGED,
  })
  assert.equal(errors.length, 1)
  assert.match(errors[0], /20260725500000_mine\.sql/)
})
