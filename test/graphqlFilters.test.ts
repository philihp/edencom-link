// Unit coverage for the GraphQL resolvers' pure argument shaping
// (src/app/api/graphql/filters.ts). What matters here is what the resolvers
// can't get wrong quietly: limit clamping against the hard caps (the request
// bound), owner matching (the same substring semantics as the MCP layer), and
// the argument parsers rejecting rather than silently widening a filter.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ASSET_CAP,
  LIST_CAP,
  clampLimit,
  matchOwnerIds,
  parseIdArg,
  parseSince,
} from '../src/app/api/graphql/filters.ts'

test('clampLimit defaults to the cap when absent or not a number', () => {
  assert.equal(clampLimit(undefined, LIST_CAP), LIST_CAP)
  assert.equal(clampLimit(null, ASSET_CAP), ASSET_CAP)
  assert.equal(clampLimit(Number.NaN, LIST_CAP), LIST_CAP)
})

test('clampLimit bounds into [1, cap] and floors fractions', () => {
  assert.equal(clampLimit(0, LIST_CAP), 1)
  assert.equal(clampLimit(-5, LIST_CAP), 1)
  assert.equal(clampLimit(2.9, LIST_CAP), 2)
  assert.equal(clampLimit(250, LIST_CAP), 250)
  assert.equal(clampLimit(999999, ASSET_CAP), ASSET_CAP)
})

const OWNERS = new Map([
  ['reg-a', 'Philihp Busby'],
  ['reg-b', 'Philihp Alt'],
  ['reg-c', 'Someone Else'],
])

test('matchOwnerIds passes null through as no filter', () => {
  assert.deepEqual(matchOwnerIds(undefined, OWNERS), { ok: true, ids: null })
  assert.deepEqual(matchOwnerIds('   ', OWNERS), { ok: true, ids: null })
})

test('matchOwnerIds matches case-insensitive substrings, possibly several', () => {
  const match = matchOwnerIds('philihp', OWNERS)
  assert.ok(match.ok)
  assert.deepEqual(match.ok && match.ids, ['reg-a', 'reg-b'])
  const exact = matchOwnerIds('someone else', OWNERS)
  assert.deepEqual(exact.ok && exact.ids, ['reg-c'])
})

test('matchOwnerIds rejects an unknown owner, listing what exists', () => {
  const match = matchOwnerIds('nobody', OWNERS)
  assert.equal(match.ok, false)
  assert.match(!match.ok ? match.message : '', /Philihp Alt, Philihp Busby, Someone Else/)
})

test('parseSince accepts ISO timestamps and date prefixes, rejects junk', () => {
  assert.deepEqual(parseSince(undefined), { ok: true, iso: null })
  const day = parseSince('2026-08-01')
  assert.ok(day.ok && day.iso === '2026-08-01T00:00:00.000Z')
  const stamp = parseSince('2026-08-01T12:30:00Z')
  assert.ok(stamp.ok && stamp.iso === '2026-08-01T12:30:00.000Z')
  assert.equal(parseSince('yesterday-ish').ok, false)
})

test('parseIdArg accepts only bare positive integer literals', () => {
  assert.deepEqual(parseIdArg(undefined, 'locationId'), { ok: true, id: null })
  assert.deepEqual(parseIdArg(' 60003760 ', 'locationId'), { ok: true, id: '60003760' })
  assert.equal(parseIdArg('60003760; drop table', 'locationId').ok, false)
  assert.equal(parseIdArg('-1', 'locationId').ok, false)
  assert.equal(parseIdArg('1e9', 'locationId').ok, false)
})
