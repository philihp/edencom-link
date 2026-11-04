// Unit coverage for src/app/api/graphql/assetWithin.ts: when the GraphQL asset
// lists take the parent-chain walk, and what they send it. The walk itself is
// SQL, covered by test/sql/asset_within.sql.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  matchesNothing,
  readWithinResult,
  walksParents,
  withinCall,
  type WithinFilters,
} from '../src/app/api/graphql/assetWithin.ts'

const none: WithinFilters = { typeIds: null, locationIds: null, include: null, exclude: null }

test('only a location or a hangar filter takes the walk', () => {
  assert.equal(walksParents(none), false)
  assert.equal(walksParents({ ...none, typeIds: [34] }), false, 'a type filter reads the views directly')
  assert.equal(walksParents({ ...none, locationIds: ['30004000'] }), true)
  assert.equal(walksParents({ ...none, include: ['CorpSAG3'] }), true)
  assert.equal(walksParents({ ...none, exclude: ['StructureFuel'] }), true)
})

test('an empty list asks for nothing, so the SQL never sees it as "no filter"', () => {
  assert.equal(matchesNothing(none), false)
  assert.equal(matchesNothing({ ...none, typeIds: [] }), true)
  assert.equal(matchesNothing({ ...none, locationIds: [] }), true)
  assert.equal(matchesNothing({ ...none, include: [] }), true)
  assert.equal(matchesNothing({ ...none, exclude: [] }), false, 'an empty exclusion drops nothing')
  assert.equal(matchesNothing({ ...none, typeIds: [34], locationIds: ['1'] }), false)
})

test('each owner side calls its own function with its own owner argument', () => {
  const filters: WithinFilters = {
    typeIds: [34],
    locationIds: ['30004000'],
    include: ['CorpSAG3', 'CorpSAG4'],
    exclude: null,
  }
  assert.deepEqual(withinCall('corporation', ['98001'], filters, 5000), {
    fn: 'corp_asset_within',
    args: {
      corporation_ids: ['98001'],
      type_ids: [34],
      location_ids: ['30004000'],
      include_flags: ['CorpSAG3', 'CorpSAG4'],
      exclude_flags: null,
      row_limit: 5000,
    },
  })
  const character = withinCall('character', ['00000000-0000-0000-0000-0000000000aa'], none, 50)
  assert.equal(character.fn, 'character_asset_within')
  assert.deepEqual(character.args.registration_ids, ['00000000-0000-0000-0000-0000000000aa'])
  assert.equal('corporation_ids' in character.args, false)
})

test('the answer is one object: the whole count, and the capped rows', () => {
  assert.deepEqual(readWithinResult({ total: 8, rows: [{ item_id: 5002 }] }), {
    total: 8,
    rows: [{ item_id: 5002 }],
  })
  assert.deepEqual(readWithinResult({ total: '3', rows: [] }), { total: 3, rows: [] })
  assert.deepEqual(readWithinResult(null), { total: 0, rows: [] })
  assert.deepEqual(readWithinResult({ total: 0, rows: null }), { total: 0, rows: [] })
})
