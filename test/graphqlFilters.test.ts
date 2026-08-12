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
  matchExactNames,
  matchOwnerFilter,
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

// The owner dimension spans both kinds of owner at once: the caller's
// characters (three id forms) and their corporations (two).
const REG_A = '11111111-1111-4111-8111-111111111111'
const REG_B = '22222222-2222-4222-8222-222222222222'

const DIRECTORY = {
  characters: {
    nameById: new Map([
      [REG_A, 'Philihp Busby'],
      [REG_B, 'Philihp Alt'],
    ]),
    characterIdById: new Map([
      [REG_A, '95465499'],
      [REG_B, '90000001'],
    ]),
  },
  corporations: new Map([
    ['98000001', 'Sanctuary of Shadows'],
    ['1000045', 'Deep Core Mining Inc.'],
  ]),
}

test('matchOwnerFilter passes an absent filter through as no scoping at all', () => {
  assert.deepEqual(matchOwnerFilter(null, null, DIRECTORY), { ok: true, scopes: null })
  assert.deepEqual(matchOwnerFilter('  ', [], DIRECTORY), { ok: true, scopes: null })
})

test('matchOwnerFilter searches character and corporation names together', () => {
  const characters = matchOwnerFilter('philihp', null, DIRECTORY)
  assert.deepEqual(characters.ok && characters.scopes, { registrationIds: [REG_A, REG_B], corporationIds: [] })
  const corporations = matchOwnerFilter('sanctuary', null, DIRECTORY)
  assert.deepEqual(corporations.ok && corporations.scopes, { registrationIds: [], corporationIds: ['98000001'] })
})

test('matchOwnerFilter mixes characters and corporations in one exact list', () => {
  const match = matchOwnerFilter(null, ['Philihp Alt', '98000001', '95465499'], DIRECTORY)
  assert.deepEqual(match.ok && match.scopes, {
    registrationIds: [REG_B, REG_A],
    corporationIds: ['98000001'],
  })
})

test('matchOwnerFilter narrows to the side that matched, leaving the other empty', () => {
  const match = matchOwnerFilter(null, ['Deep Core Mining Inc.'], DIRECTORY)
  assert.deepEqual(match.ok && match.scopes, { registrationIds: [], corporationIds: ['1000045'] })
})

test('matchOwnerFilter rejects what matched neither side, listing both', () => {
  const match = matchOwnerFilter(null, ['Nobody'], DIRECTORY)
  assert.equal(match.ok, false)
  const message = !match.ok ? match.message : ''
  assert.match(message, /"Nobody"/)
  assert.match(message, /Philihp Busby \(95465499\)/)
  assert.match(message, /Sanctuary of Shadows \(98000001, corporation\)/)
  assert.equal(matchOwnerFilter('nobody', null, DIRECTORY).ok, false)
})

test('matchOwnerFilter refuses the singular and plural together', () => {
  const both = matchOwnerFilter('philihp', ['Philihp Alt'], DIRECTORY)
  assert.equal(both.ok, false)
  assert.match(!both.ok ? both.message : '', /Pass owner or owners, not both/)
})
