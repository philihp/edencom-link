// Which structures /structure lists, and which of its three blocks each lands
// in. The case that drove it: a corp rents slots in somebody else's Sotiyo. The
// facility id is right there on our own industry jobs, but the page listed
// `corp_structure` and nothing else, so the structure our slots actually ran in
// appeared only as ISK under "taxes paid elsewhere" — no tile, no name, no
// system.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  groupByTier,
  isPlayerStructureId,
  jobLocationId,
  jobStructureIds,
  structureTier,
  STRUCTURE_ID_FLOOR,
} from '../src/app/structure/roster.ts'

const OURS = 'corp-1'
const STRANGER = 'corp-2'

const ownCorporationIds = new Set([OURS])
const noFavorites = new Map<string, number>()

const structure = (structureId: string, ownerCorporationId: string | null, scanned: boolean) => ({
  structureId,
  ownerCorporationId,
  scanned,
})

test('an NPC station is nobody structure', () => {
  // Jita 4-4 and friends sit far below the floor; a job installed in one gets
  // no tile, because there is no structure to tile.
  assert.equal(isPlayerStructureId(60_003_760), false)
  assert.equal(isPlayerStructureId(STRUCTURE_ID_FLOOR), true)
  assert.equal(isPlayerStructureId(null), false)
  assert.equal(isPlayerStructureId(undefined), false)
  // PostgREST hands bigints back as strings often enough that a numeric-only
  // check would silently drop half the roster.
  assert.equal(isPlayerStructureId('1000000000001'), true)
})

test('a job resolves to its station, falling back to its facility', () => {
  assert.equal(jobLocationId({ station_id: '1000000000001', facility_id: '1000000000002' }), '1000000000001')
  assert.equal(jobLocationId({ station_id: null, facility_id: '1000000000002' }), '1000000000002')
  assert.equal(jobLocationId({ station_id: 60_003_760, facility_id: null }), null)
})

test('discovery pools every player structure our jobs ran in, once each', () => {
  assert.deepEqual(
    jobStructureIds([
      { station_id: '1000000000001', facility_id: null },
      { station_id: null, facility_id: '1000000000001' },
      { station_id: null, facility_id: '1000000000002' },
      { station_id: 60_003_760, facility_id: null },
      { station_id: null, facility_id: null },
    ]),
    ['1000000000001', '1000000000002']
  )
})

test('a structure we scan is ours, alliance-mate or not', () => {
  // corp_structure's RLS is own-corps OR alliance-mates, and both are things a
  // director token pulls. "Ours" is the set we scan — which is exactly the
  // distinction the third block is defined against.
  assert.equal(
    structureTier(structure('1', STRANGER, true), { favoritePosition: noFavorites, ownCorporationIds }),
    'ours'
  )
})

test('our own corp structure is ours even when no director can scan it', () => {
  // The gap the roster exists to fill: a corp we're in that no linked character
  // holds Station_Manager in. It is absent from corp_structure, so it arrives
  // through discovery — and filing our own Athanor under everyone else's would
  // be perverse.
  assert.equal(structureTier(structure('1', OURS, false), { favoritePosition: noFavorites, ownCorporationIds }), 'ours')
})

test('a stranger structure, and one nobody could name, are everyone elses', () => {
  assert.equal(
    structureTier(structure('1', STRANGER, false), { favoritePosition: noFavorites, ownCorporationIds }),
    'others'
  )
  // No directory row: we know a job of ours ran there and nothing else. We
  // can't claim it, so we don't.
  assert.equal(
    structureTier(structure('2', null, false), { favoritePosition: noFavorites, ownCorporationIds }),
    'others'
  )
})

test('a pin lifts a tile out of whichever block it would sit in', () => {
  const favoritePosition = new Map([
    ['3', 1],
    ['1', 0],
  ])
  const tiers = groupByTier(
    [
      structure('1', OURS, true),
      structure('2', OURS, true),
      structure('3', STRANGER, false),
      structure('4', STRANGER, false),
    ],
    { favoritePosition, ownCorporationIds }
  )
  // Both pins, in their drag order rather than the order they arrived — a
  // scanned structure and a stranger's side by side.
  assert.deepEqual(
    tiers.favorites.map((s) => s.structureId),
    ['1', '3']
  )
  assert.deepEqual(
    tiers.ours.map((s) => s.structureId),
    ['2']
  )
  assert.deepEqual(
    tiers.others.map((s) => s.structureId),
    ['4']
  )
})

test('the blocks preserve the callers order, and lose nothing', () => {
  const list = [structure('9', OURS, true), structure('8', OURS, true), structure('7', STRANGER, false)]
  const tiers = groupByTier(list, { favoritePosition: noFavorites, ownCorporationIds })
  assert.deepEqual(
    tiers.ours.map((s) => s.structureId),
    ['9', '8']
  )
  assert.equal(tiers.favorites.length + tiers.ours.length + tiers.others.length, list.length)
})
