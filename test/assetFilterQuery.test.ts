// Unit coverage for the list_assets argument seam — the id parsing and the
// owner split that decide what reaches character_asset_filter() /
// corp_asset_filter(). The filtering itself is SQL (test/sql/asset_filter.sql);
// what's testable here is that ids survive intact and that an owner the caller
// can't see is refused rather than quietly dropped.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_IDS,
  parseIdList,
  scopesToQuery,
  splitOwnerIds,
  type OwnerDirectory,
} from '../src/app/api/mcp/assetFilterQuery.ts'

const directory: OwnerDirectory = {
  registrations: [
    { registrationId: '00000000-0000-0000-0000-00000000000a', characterId: '95465499', name: 'Pilot One' },
    { registrationId: '00000000-0000-0000-0000-00000000000b', characterId: '90000001', name: 'Pilot Two' },
  ],
  corporations: [{ corporationId: '98000001', name: 'Test Corp' }],
}

test('an absent list means no filter', () => {
  assert.deepEqual(parseIdList(undefined, 'type_ids'), { ok: true, ids: [] })
  assert.deepEqual(parseIdList([], 'type_ids'), { ok: true, ids: [] })
})

test('numbers and strings both normalise to decimal strings, deduped', () => {
  const parsed = parseIdList([34, '34', ' 4247 ', '0060003760'], 'type_ids')
  assert.deepEqual(parsed, { ok: true, ids: ['34', '4247', '60003760'] })
})

test('ids past 2^53 survive as strings', () => {
  // A structure id is comfortably inside 2^53, but item ids in the same list
  // are not always: parsing must never round-trip through a JS number.
  const big = '9007199254740993'
  const parsed = parseIdList([big], 'location_ids')
  assert.deepEqual(parsed, { ok: true, ids: [big] })
})

test('non-numeric ids are refused, naming the offenders', () => {
  const parsed = parseIdList(['34', 'jita', '-5', '1.5'], 'location_ids')
  assert.equal(parsed.ok, false)
  assert.match(parsed.ok === false ? parsed.message : '', /jita, -5, 1\.5/)
})

test('an absurdly long list is refused rather than sent', () => {
  const parsed = parseIdList(
    Array.from({ length: MAX_IDS + 1 }, (_, i) => i + 1),
    'type_ids'
  )
  assert.equal(parsed.ok, false)
  assert.match(parsed.ok === false ? parsed.message : '', new RegExp(`${MAX_IDS}`))
})

test('characters are addressable by registration uuid or EVE character id', () => {
  const byUuid = splitOwnerIds(['00000000-0000-0000-0000-00000000000A'], directory)
  const byCharacter = splitOwnerIds([95465499], directory)
  assert.deepEqual(byUuid, {
    ok: true,
    registrationIds: ['00000000-0000-0000-0000-00000000000a'],
    corporationIds: [],
    names: ['Pilot One'],
  })
  assert.deepEqual(byCharacter, byUuid)
})

test('corporations split out of the same list', () => {
  const split = splitOwnerIds(['98000001', '90000001'], directory)
  assert.deepEqual(split, {
    ok: true,
    registrationIds: ['00000000-0000-0000-0000-00000000000b'],
    corporationIds: ['98000001'],
    names: ['Test Corp', 'Pilot Two'],
  })
})

test('an owner the caller cannot see is refused, listing what is available', () => {
  const split = splitOwnerIds(['12345'], directory)
  assert.equal(split.ok, false)
  const message = split.ok === false ? split.message : ''
  assert.match(message, /12345/)
  assert.match(message, /Pilot One \(character 95465499\)/)
  assert.match(message, /Test Corp \(corporation 98000001\)/)
})

test('no owner filter queries both scopes; naming one scope skips the other', () => {
  assert.deepEqual(scopesToQuery({ registrationIds: [], corporationIds: [] }), { character: true, corp: true })
  assert.deepEqual(scopesToQuery({ registrationIds: ['a'], corporationIds: [] }), { character: true, corp: false })
  assert.deepEqual(scopesToQuery({ registrationIds: [], corporationIds: ['1'] }), { character: false, corp: true })
  assert.deepEqual(scopesToQuery({ registrationIds: ['a'], corporationIds: ['1'] }), { character: true, corp: true })
})
