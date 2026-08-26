// Unit coverage for the /registration grant-matrix rules: the four cell
// states fusing grant and job, the any-scope rule for multi-scope columns
// (character-status), the mixed template checkbox, the re-auth trailing set,
// and the two page headlines (blocked count, soonest sweep).
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  blockedCellCount,
  columnGrant,
  grantAllowsRun,
  soonestNextRun,
  templateCheck,
  trailingScopes,
} from '../src/app/registration/matrix.ts'

const ASSETS = ['esi-assets.read_assets.v1']
const STATUS = ['esi-wallet.read_character_wallet.v1', 'esi-location.read_location.v1']

test('columnGrant: requested and granted is on', () => {
  assert.equal(columnGrant(ASSETS, new Set(ASSETS), new Set(ASSETS)), 'on')
})

test('columnGrant: requested but not granted is missing — the job never runs', () => {
  assert.equal(columnGrant(ASSETS, new Set(), new Set(ASSETS)), 'missing')
})

test('columnGrant: granted but not in the template still runs, as extra', () => {
  assert.equal(columnGrant(ASSETS, new Set(ASSETS), new Set()), 'extra')
})

test('columnGrant: neither requested nor granted is off', () => {
  assert.equal(columnGrant(ASSETS, new Set(), new Set()), 'off')
})

test('columnGrant: a multi-scope column is granted by ANY of its scopes', () => {
  // character-status runs whichever endpoints the token carries, so one grant
  // out of six is a runnable job, not a missing one.
  assert.equal(columnGrant(STATUS, new Set([STATUS[1]]), new Set(STATUS)), 'on')
})

test('grantAllowsRun: only on and extra cells have anything to kick', () => {
  assert.equal(grantAllowsRun('on'), true)
  assert.equal(grantAllowsRun('extra'), true)
  assert.equal(grantAllowsRun('missing'), false)
  assert.equal(grantAllowsRun('off'), false)
})

test('templateCheck: all, some and none of a column’s scopes', () => {
  assert.equal(templateCheck(STATUS, new Set(STATUS)), 'all')
  assert.equal(templateCheck(STATUS, new Set([STATUS[0]])), 'some')
  assert.equal(templateCheck(STATUS, new Set()), 'none')
})

test('trailingScopes: what a re-auth would catch up, over the whole template', () => {
  const template = new Set(['a', 'b', 'c'])
  assert.deepEqual(trailingScopes(template, new Set(['a'])), ['b', 'c'])
  // A token can carry more than the template asks; extras never count against it.
  assert.deepEqual(trailingScopes(template, new Set(['a', 'b', 'c', 'd'])), [])
  // No token at all trails by the entire template.
  assert.deepEqual(trailingScopes(template, new Set()), ['a', 'b', 'c'])
})

test('blockedCellCount counts only missing cells', () => {
  assert.equal(blockedCellCount(['on', 'missing', 'extra', 'off', 'missing']), 2)
  assert.equal(blockedCellCount([]), 0)
})

test('soonestNextRun picks the earliest fire and ignores manual-only jobs', () => {
  const early = new Date('2026-08-26T01:00:00Z')
  const late = new Date('2026-08-26T09:00:00Z')
  assert.equal(soonestNextRun([late, null, early]), early)
  assert.equal(soonestNextRun([null, null]), null)
  assert.equal(soonestNextRun([]), null)
})
