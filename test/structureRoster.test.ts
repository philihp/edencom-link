// Which structures /structure lists, and which of its three blocks each lands
// in. The case that drove it: a corp rents slots in somebody else's Sotiyo. The
// facility id is right there on our own industry jobs, but the page listed
// `corp_structure` and nothing else, so the structure our slots actually ran in
// appeared only as ISK under "taxes paid elsewhere" — no tile, no name, no
// system.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  foldJobCost,
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

// What a structure cost us. The case that drove it: a character installs jobs
// in somebody else's Raitaru. The ISK leaves a personal wallet and lands in a
// corporation wallet we have no journal for, so both tax measures on that tile
// are blank however much work we run there. The job rows still say what we were
// charged.
const onPage = new Set(['1000000000001', '1000000000002'])
const SINCE = '2026-08-01T00:00:00Z'

test('job cost sums what we were charged, per structure', () => {
  const costs = foldJobCost(
    [
      { job_id: 1, station_id: '1000000000001', facility_id: null, cost: 1000, start_date: '2026-08-10T00:00:00Z' },
      { job_id: 2, station_id: null, facility_id: '1000000000001', cost: '250.5', start_date: '2026-08-11T00:00:00Z' },
      { job_id: 3, station_id: '1000000000002', facility_id: null, cost: 40, start_date: '2026-08-12T00:00:00Z' },
    ],
    { onPage, since: SINCE }
  )
  assert.deepEqual(costs.get('1000000000001'), { isk: 1250.5, jobs: 2 })
  assert.deepEqual(costs.get('1000000000002'), { isk: 40, jobs: 1 })
})

test('one job is charged once, however many tables list it', () => {
  // The character and corporation extracts can both carry the same job. The tax
  // fold keeps `credited`/`paid` sets for exactly this reason; so does this one.
  const costs = foldJobCost(
    [
      { job_id: 7, station_id: '1000000000001', facility_id: null, cost: 900, start_date: '2026-08-10T00:00:00Z' },
      { job_id: 7, station_id: '1000000000001', facility_id: null, cost: 900, start_date: '2026-08-10T00:00:00Z' },
    ],
    { onPage, since: SINCE }
  )
  assert.deepEqual(costs.get('1000000000001'), { isk: 900, jobs: 1 })
})

test('the window filters on installation, which is when the ISK was charged', () => {
  // A job still running was paid for on the day it was installed, not on the day
  // it delivers — so an old job stays out of a short window even if it is live.
  const costs = foldJobCost(
    [{ job_id: 1, station_id: '1000000000001', facility_id: null, cost: 500, start_date: '2026-07-30T00:00:00Z' }],
    { onPage, since: SINCE }
  )
  assert.equal(costs.size, 0)
})

test('a job off the page, or with no cost, contributes nothing', () => {
  const costs = foldJobCost(
    [
      // Ran somewhere with no tile — same rule the tax fold applies.
      { job_id: 1, station_id: '1000000000009', facility_id: null, cost: 500, start_date: '2026-08-10T00:00:00Z' },
      // An NPC station: below the id floor, so not a structure at all.
      { job_id: 2, station_id: 60_003_760, facility_id: null, cost: 500, start_date: '2026-08-10T00:00:00Z' },
      // ESI gave no cost. Zero would read as "this was free", which is a
      // different claim from "we don't know".
      { job_id: 3, station_id: '1000000000001', facility_id: null, cost: null, start_date: '2026-08-10T00:00:00Z' },
      { job_id: 4, station_id: '1000000000001', facility_id: null, cost: 0, start_date: '2026-08-10T00:00:00Z' },
      // No install date to place in the window.
      { job_id: 5, station_id: '1000000000001', facility_id: null, cost: 500, start_date: null },
    ],
    { onPage, since: SINCE }
  )
  assert.equal(costs.size, 0)
})
