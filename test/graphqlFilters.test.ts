// Unit coverage for the GraphQL resolvers' pure argument shaping
// (src/app/api/graphql/filters.ts). What matters here is what the resolvers
// can't get wrong quietly: limit clamping against the hard caps (the request
// bound), character matching (the same substring semantics as the MCP layer),
// and the argument parsers rejecting rather than silently widening a filter.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ASSET_CAP,
  LIST_CAP,
  clampLimit,
  matchCharacterFilter,
  matchCharacterName,
  matchCharacterRefs,
  matchCorporationFilter,
  matchExactNames,
  parseRefFilter,
  parseSince,
  splitRefEntries,
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

test('matchCharacterName passes null through as no filter', () => {
  assert.deepEqual(matchCharacterName(undefined, OWNERS), { ok: true, ids: null })
  assert.deepEqual(matchCharacterName('   ', OWNERS), { ok: true, ids: null })
})

test('matchCharacterName matches case-insensitive substrings, possibly several', () => {
  const match = matchCharacterName('philihp', OWNERS)
  assert.ok(match.ok)
  assert.deepEqual(match.ok && match.ids, ['reg-a', 'reg-b'])
  const exact = matchCharacterName('someone else', OWNERS)
  assert.deepEqual(exact.ok && exact.ids, ['reg-c'])
})

test('matchCharacterName rejects an unknown character, listing what exists', () => {
  const match = matchCharacterName('nobody', OWNERS)
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

test('matchCharacterRefs passes an absent or empty list through as no filter', () => {
  assert.deepEqual(matchCharacterRefs(undefined, DIRECTORY), { ok: true, ids: null })
  assert.deepEqual(matchCharacterRefs([], DIRECTORY), { ok: true, ids: null })
  assert.deepEqual(matchCharacterRefs(['  '], DIRECTORY), { ok: true, ids: null })
})

test('matchCharacterRefs takes whole names, EVE character ids and registration ids, mixed', () => {
  const byName = matchCharacterRefs(['philihp busby', 'Someone Else'], DIRECTORY)
  assert.deepEqual(byName.ok && byName.ids, [REG_A, REG_C])
  const byCharacterId = matchCharacterRefs(['95465499'], DIRECTORY)
  assert.deepEqual(byCharacterId.ok && byCharacterId.ids, [REG_A])
  const mixed = matchCharacterRefs([REG_B, '95465499', 'Someone Else'], DIRECTORY)
  assert.deepEqual(mixed.ok && mixed.ids, [REG_B, REG_A, REG_C])
})

test('matchCharacterRefs dedupes a character named twice', () => {
  const match = matchCharacterRefs(['Philihp Busby', '95465499', REG_A], DIRECTORY)
  assert.deepEqual(match.ok && match.ids, [REG_A])
})

test('matchCharacterRefs matches names whole, not by substring — that is what character: is for', () => {
  const partial = matchCharacterRefs(['philihp'], DIRECTORY)
  assert.equal(partial.ok, false)
  assert.match(!partial.ok ? partial.message : '', /"philihp"/)
})

test('matchCharacterRefs rejects unknown entries, listing names with their character ids', () => {
  const match = matchCharacterRefs(['Someone Else', 'Nobody', '12345'], DIRECTORY)
  assert.equal(match.ok, false)
  const message = !match.ok ? match.message : ''
  assert.match(message, /"Nobody", "12345"/)
  assert.match(message, /Philihp Busby \(95465499\)/)
})

test('matchCharacterFilter routes to the fuzzy or the exact matcher, never both', () => {
  const none = matchCharacterFilter(null, null, DIRECTORY)
  assert.deepEqual(none, { ok: true, ids: null })
  const fuzzy = matchCharacterFilter('philihp', null, DIRECTORY)
  assert.deepEqual(fuzzy.ok && fuzzy.ids, [REG_A, REG_B])
  const exact = matchCharacterFilter(null, ['Philihp Alt'], DIRECTORY)
  assert.deepEqual(exact.ok && exact.ids, [REG_B])
  const both = matchCharacterFilter('philihp', ['Philihp Alt'], DIRECTORY)
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

// The shape every filter dimension shares (character, location, type): a
// singular name search, a plural exact list, never both.
test('parseRefFilter reads an absent filter as none', () => {
  assert.deepEqual(parseRefFilter(undefined, undefined, 'type'), { ok: true, query: { kind: 'none' } })
  assert.deepEqual(parseRefFilter('  ', [], 'type'), { ok: true, query: { kind: 'none' } })
  assert.deepEqual(parseRefFilter(null, ['  '], 'type'), { ok: true, query: { kind: 'none' } })
})

test('parseRefFilter reads the singular as a search and the plural as an exact list', () => {
  assert.deepEqual(parseRefFilter(' Fuel Block ', null, 'type'), {
    ok: true,
    query: { kind: 'search', term: 'Fuel Block' },
  })
  assert.deepEqual(parseRefFilter(null, [' 4051 ', 'Nitrogen Fuel Block', '4051'], 'type'), {
    ok: true,
    query: { kind: 'exact', entries: ['4051', 'Nitrogen Fuel Block'] },
  })
})

test('parseRefFilter refuses both, naming the pair it was given', () => {
  const both = parseRefFilter('jita', ['60003760'], 'location')
  assert.equal(both.ok, false)
  assert.match(!both.ok ? both.message : '', /Pass location or locations, not both/)
})

test('splitRefEntries calls a bare integer an id and everything else a name', () => {
  assert.deepEqual(splitRefEntries(['4051', 'Tritanium', '60003760', '1MN Afterburner II']), {
    ids: ['4051', '60003760'],
    names: ['Tritanium', '1MN Afterburner II'],
  })
})

test('matchExactNames takes whole names only, keeping every candidate that matches', () => {
  const candidates = {
    Tritanium: [
      { id: '34', name: 'Tritanium' },
      { id: '35', name: 'Tritanium Bar' },
    ],
    jita: [{ id: '30000142', name: 'Jita' }],
  }
  const matched = matchExactNames(['Tritanium', 'jita'], (name) => candidates[name] ?? [])
  assert.deepEqual(matched, { ids: ['34', '30000142'], unmatched: [] })
})

test('matchExactNames reports what matched nothing, rather than dropping it', () => {
  const matched = matchExactNames(['Trit'], () => [{ id: '34', name: 'Tritanium' }])
  assert.deepEqual(matched, { ids: [], unmatched: ['Trit'] })
})

// The corporation dimension: same pair, over the corporations the caller's
// characters belong to. Two id forms only — there's no registration uuid
// behind a corporation.
const CORPORATIONS = new Map([
  ['98000001', 'Sanctuary of Shadows'],
  ['98000002', 'Shadow Cartel'],
  ['1000045', 'Deep Core Mining Inc.'],
])

test('matchCorporationFilter passes an absent filter through', () => {
  assert.deepEqual(matchCorporationFilter(null, null, CORPORATIONS), { ok: true, ids: null })
  assert.deepEqual(matchCorporationFilter('  ', [], CORPORATIONS), { ok: true, ids: null })
})

test('matchCorporationFilter substring-searches names in the singular', () => {
  const match = matchCorporationFilter('shadow', null, CORPORATIONS)
  assert.deepEqual(match.ok && match.ids, ['98000001', '98000002'])
})

test('matchCorporationFilter takes whole names and corporation ids in the plural', () => {
  const match = matchCorporationFilter(null, ['shadow cartel', '1000045'], CORPORATIONS)
  assert.deepEqual(match.ok && match.ids, ['1000045', '98000002'].sort())
})

test('matchCorporationFilter rejects unknown entries and a partial name, listing what exists', () => {
  const unknown = matchCorporationFilter(null, ['98009999'], CORPORATIONS)
  assert.equal(unknown.ok, false)
  assert.match(!unknown.ok ? unknown.message : '', /Deep Core Mining Inc\. \(1000045\)/)
  const partial = matchCorporationFilter(null, ['shadow'], CORPORATIONS)
  assert.equal(partial.ok, false)
  const missing = matchCorporationFilter('nobody', null, CORPORATIONS)
  assert.equal(missing.ok, false)
})

test('matchCorporationFilter refuses the singular and plural together', () => {
  const both = matchCorporationFilter('shadow', ['Shadow Cartel'], CORPORATIONS)
  assert.equal(both.ok, false)
  assert.match(!both.ok ? both.message : '', /Pass corporation or corporations, not both/)
})
