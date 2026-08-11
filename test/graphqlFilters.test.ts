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
  matchOwnerFilter,
  matchOwnerIds,
  matchOwnerRefs,
  parseIdArg,
  parseSince,
  parseTypeIdsArg,
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

// The list filter resolves against both maps the context carries: registration
// uuid → name, and registration uuid → EVE character id.
const REG_A = '11111111-1111-4111-8111-111111111111'
const REG_B = '22222222-2222-4222-8222-222222222222'
const REG_C = '33333333-3333-4333-8333-333333333333'

const DIRECTORY = {
  nameById: new Map([
    [REG_A, 'Philihp Busby'],
    [REG_B, 'Philihp Alt'],
    [REG_C, 'Someone Else'],
  ]),
  characterIdById: new Map([
    [REG_A, '95465499'],
    [REG_B, '90000001'],
    [REG_C, '90000002'],
  ]),
}

test('matchOwnerRefs passes an absent or empty list through as no filter', () => {
  assert.deepEqual(matchOwnerRefs(undefined, DIRECTORY), { ok: true, ids: null })
  assert.deepEqual(matchOwnerRefs([], DIRECTORY), { ok: true, ids: null })
  assert.deepEqual(matchOwnerRefs(['  '], DIRECTORY), { ok: true, ids: null })
})

test('matchOwnerRefs takes whole names, EVE character ids and registration ids, mixed', () => {
  const byName = matchOwnerRefs(['philihp busby', 'Someone Else'], DIRECTORY)
  assert.deepEqual(byName.ok && byName.ids, [REG_A, REG_C])
  const byCharacterId = matchOwnerRefs(['95465499'], DIRECTORY)
  assert.deepEqual(byCharacterId.ok && byCharacterId.ids, [REG_A])
  const mixed = matchOwnerRefs([REG_B, '95465499', 'Someone Else'], DIRECTORY)
  assert.deepEqual(mixed.ok && mixed.ids, [REG_B, REG_A, REG_C])
})

test('matchOwnerRefs dedupes a character named twice', () => {
  const match = matchOwnerRefs(['Philihp Busby', '95465499', REG_A], DIRECTORY)
  assert.deepEqual(match.ok && match.ids, [REG_A])
})

test('matchOwnerRefs matches names whole, not by substring — that is what owner: is for', () => {
  const partial = matchOwnerRefs(['philihp'], DIRECTORY)
  assert.equal(partial.ok, false)
  assert.match(!partial.ok ? partial.message : '', /"philihp"/)
})

test('matchOwnerRefs rejects unknown entries, listing names with their character ids', () => {
  const match = matchOwnerRefs(['Someone Else', 'Nobody', '12345'], DIRECTORY)
  assert.equal(match.ok, false)
  const message = !match.ok ? match.message : ''
  assert.match(message, /"Nobody", "12345"/)
  assert.match(message, /Philihp Busby \(95465499\)/)
})

test('matchOwnerFilter routes to the fuzzy or the exact matcher, never both', () => {
  const none = matchOwnerFilter(null, null, DIRECTORY)
  assert.deepEqual(none, { ok: true, ids: null })
  const fuzzy = matchOwnerFilter('philihp', null, DIRECTORY)
  assert.deepEqual(fuzzy.ok && fuzzy.ids, [REG_A, REG_B])
  const exact = matchOwnerFilter(null, ['Philihp Alt'], DIRECTORY)
  assert.deepEqual(exact.ok && exact.ids, [REG_B])
  const both = matchOwnerFilter('philihp', ['Philihp Alt'], DIRECTORY)
  assert.equal(both.ok, false)
  assert.match(!both.ok ? both.message : '', /not both/)
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

test('parseTypeIdsArg returns null when no ids are given', () => {
  assert.deepEqual(parseTypeIdsArg(undefined, undefined), { ok: true, ids: null })
  assert.deepEqual(parseTypeIdsArg([], 'Fuel Block'), { ok: true, ids: null })
  assert.deepEqual(parseTypeIdsArg(['  '], undefined), { ok: true, ids: null })
})

test('parseTypeIdsArg parses, trims and dedupes exact ids', () => {
  assert.deepEqual(parseTypeIdsArg([' 4051 ', '4246', '4051'], undefined), { ok: true, ids: [4051, 4246] })
})

test('parseTypeIdsArg refuses typeIds and typeName together', () => {
  const both = parseTypeIdsArg(['4051'], 'Fuel Block')
  assert.equal(both.ok, false)
  assert.match(!both.ok ? both.message : '', /not both/)
})

test('parseTypeIdsArg rejects non-numeric ids rather than widening', () => {
  assert.equal(parseTypeIdsArg(['4051', 'Tritanium'], undefined).ok, false)
  assert.equal(parseTypeIdsArg(['-4051'], undefined).ok, false)
  assert.equal(parseTypeIdsArg(['4051; drop table'], undefined).ok, false)
})
