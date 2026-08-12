// Unit coverage for the list_planets seam (docs/mcp-search-exploration.md).
//
// What's worth pinning here is the shaping the tool can't get wrong quietly:
// planet-type resolution comes from SDE group 7 rather than a hardcoded list
// (so a new CCP planet type works and a typo fails loudly), and the region
// rollup has to rank systems by how many *matching* planets they hold — that
// ordering is the whole point of "which systems have temperate planets".
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  composition,
  formatPlanet,
  matchPlanetTypes,
  planetTypeName,
  rollupSystems,
  type PlanetLike,
} from '../src/app/api/mcp/planetQuery.ts'

const TEMPERATE = 11
const BARREN = 2016
const LAVA = 2015

// The names CCP actually ships, stem and all — the matcher's substring
// behaviour only reads correctly against the real shape.
const PLANET_TYPES = [
  { typeID: TEMPERATE, name: 'Planet (Temperate)' },
  { typeID: BARREN, name: 'Planet (Barren)' },
  { typeID: LAVA, name: 'Planet (Lava)' },
  { typeID: 2017, name: 'Planet (Shattered)' },
]

const TYPE_NAMES: Record<number, string> = Object.fromEntries(PLANET_TYPES.map((t) => [t.typeID, t.name]))

const planet = (over: Partial<PlanetLike> = {}): PlanetLike => ({
  planetID: 40099763,
  systemID: 30004759,
  systemName: 'Q-UVY6',
  celestialIndex: 2,
  typeID: TEMPERATE,
  name: 'Q-UVY6 II',
  security: -0.019999999552965164,
  regionName: 'Pure Blind',
  ...over,
})

test('matchPlanetTypes resolves a bare word against the SDE names', () => {
  const match = matchPlanetTypes(PLANET_TYPES, 'temperate')
  assert.deepEqual(match, { ok: true, typeIDs: [TEMPERATE], names: ['Planet (Temperate)'] })
})

test('matchPlanetTypes is case-insensitive and accepts the full name', () => {
  assert.deepEqual(matchPlanetTypes(PLANET_TYPES, 'Planet (Lava)'), {
    ok: true,
    typeIDs: [LAVA],
    names: ['Planet (Lava)'],
  })
  const lava = matchPlanetTypes(PLANET_TYPES, 'LAVA')
  assert.deepEqual(lava.ok ? lava.typeIDs : null, [LAVA])
})

test('matchPlanetTypes treats a missing query as no filter, not as no matches', () => {
  assert.deepEqual(matchPlanetTypes(PLANET_TYPES, undefined), { ok: true, typeIDs: null, names: [] })
  assert.deepEqual(matchPlanetTypes(PLANET_TYPES, '   '), { ok: true, typeIDs: null, names: [] })
})

test('matchPlanetTypes fails a typo and lists what exists', () => {
  const match = matchPlanetTypes(PLANET_TYPES, 'temprate')
  assert.equal(match.ok, false)
  assert.match(match.ok === false ? match.message : '', /No planet type matched "temprate"/)
  // The available list is what makes the failure self-correcting.
  assert.match(match.ok === false ? match.message : '', /Planet \(Temperate\)/)
})

test('matchPlanetTypes keeps a deliberately broad query broad', () => {
  // "planet" is in every name — the caller asked for everything, so give it.
  const broad = matchPlanetTypes(PLANET_TYPES, 'planet')
  assert.equal(broad.ok ? broad.typeIDs?.length : null, PLANET_TYPES.length)
})

test('planetTypeName falls back rather than dropping an unmirrored type', () => {
  assert.equal(planetTypeName(TYPE_NAMES, TEMPERATE), 'Planet (Temperate)')
  assert.equal(planetTypeName(TYPE_NAMES, 99999), 'Type #99999')
  assert.equal(planetTypeName(TYPE_NAMES, null), 'Unknown')
})

test('formatPlanet rounds security to the one decimal EVE displays', () => {
  const row = formatPlanet(planet(), TYPE_NAMES)
  assert.deepEqual(row, {
    planet_id: 40099763,
    name: 'Q-UVY6 II',
    type: 'Planet (Temperate)',
    system: 'Q-UVY6',
    system_id: 30004759,
    region: 'Pure Blind',
    security: 0, // -0.0199… displays as 0.0, not as raw float noise
  })
})

test('formatPlanet carries a null security through instead of coercing to 0', () => {
  assert.equal(formatPlanet(planet({ security: null }), TYPE_NAMES).security, null)
})

test('composition counts by type name, most common first', () => {
  const planets = [
    planet({ planetID: 1, typeID: BARREN }),
    planet({ planetID: 2, typeID: TEMPERATE }),
    planet({ planetID: 3, typeID: BARREN }),
    planet({ planetID: 4, typeID: BARREN }),
    planet({ planetID: 5, typeID: LAVA }),
  ]
  assert.deepEqual(Object.entries(composition(planets, TYPE_NAMES)), [
    ['Planet (Barren)', 3],
    ['Planet (Lava)', 1],
    ['Planet (Temperate)', 1],
  ])
})

test('rollupSystems ranks systems by matching planets, not by total planets', () => {
  const planets = [
    // A big system with one temperate planet…
    planet({ planetID: 1, systemID: 100, systemName: 'Alpha', typeID: TEMPERATE }),
    planet({ planetID: 2, systemID: 100, systemName: 'Alpha', typeID: BARREN }),
    planet({ planetID: 3, systemID: 100, systemName: 'Alpha', typeID: BARREN }),
    // …loses to a small one with two.
    planet({ planetID: 4, systemID: 200, systemName: 'Beta', typeID: TEMPERATE }),
    planet({ planetID: 5, systemID: 200, systemName: 'Beta', typeID: TEMPERATE }),
  ]
  const rolled = rollupSystems(planets, TYPE_NAMES, [TEMPERATE])
  assert.deepEqual(
    rolled.map((r) => [r.system, r.matching_planets]),
    [
      ['Beta', 2],
      ['Alpha', 1],
    ]
  )
  // Each rollup still reports the full breakdown of what it was given.
  assert.deepEqual(rolled[1].planets, { 'Planet (Barren)': 2, 'Planet (Temperate)': 1 })
})

test('rollupSystems with no type filter counts every planet as matching', () => {
  const planets = [
    planet({ planetID: 1, systemID: 100, systemName: 'Alpha', typeID: BARREN }),
    planet({ planetID: 2, systemID: 200, systemName: 'Beta', typeID: LAVA }),
    planet({ planetID: 3, systemID: 200, systemName: 'Beta', typeID: BARREN }),
  ]
  assert.deepEqual(
    rollupSystems(planets, TYPE_NAMES, null).map((r) => [r.system, r.matching_planets]),
    [
      ['Beta', 2],
      ['Alpha', 1],
    ]
  )
})

test('rollupSystems breaks a tie by system name so the order is stable', () => {
  const planets = [
    planet({ planetID: 1, systemID: 300, systemName: 'Zulu', typeID: TEMPERATE }),
    planet({ planetID: 2, systemID: 100, systemName: 'Alpha', typeID: TEMPERATE }),
    planet({ planetID: 3, systemID: 200, systemName: 'Mike', typeID: TEMPERATE }),
  ]
  assert.deepEqual(
    rollupSystems(planets, TYPE_NAMES, [TEMPERATE]).map((r) => r.system),
    ['Alpha', 'Mike', 'Zulu']
  )
})

test('rollupSystems rounds the system security once, on the rollup', () => {
  const rolled = rollupSystems([planet({ security: 0.9539999961853027 })], TYPE_NAMES, null)
  assert.equal(rolled[0].security, 1)
  assert.equal(rollupSystems([planet({ security: 0.44 })], TYPE_NAMES, null)[0].security, 0.4)
})
