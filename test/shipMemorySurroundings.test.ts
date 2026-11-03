// What stands around a ship's home (src/app/ship/memory/surroundings.ts,
// docs/ship-memory.md "Surroundings"): the home system picked from the debut
// else the longest dwell, stations trimmed with the peopled ones first, a
// corporation's blurb cut to its first sentence, temperate planets nearest
// first.
import assert from 'node:assert/strict'
import test from 'node:test'

import type { Place, Stop } from '../src/app/ship/memory/dossier.ts'
import {
  firstSentence,
  homeSystemOf,
  MAX_PLANETS,
  MAX_STATIONS,
  pickSurroundings,
} from '../src/app/ship/memory/surroundings.ts'

const RENS = 30002510
const HEK = 30002053
const systemOf = (p: Place): number | null =>
  p.type === 'solar_system' ? p.id : p.id === 60004588 ? RENS : p.id === 60005686 ? HEK : null
const stop = (place: Place | null, hours: number): Stop => ({
  place,
  parentId: null,
  arrived: '2026-01-01T00:00:00Z',
  departed: null,
  hours,
})

test('the home system is the debut place when it resolves, else the longest dwell, else none', () => {
  const stops = [stop({ id: 60005686, type: 'station' }, 100), stop({ id: 60004588, type: 'station' }, 10)]
  assert.equal(homeSystemOf({ id: 60004588, type: 'station' }, stops, systemOf), RENS)
  assert.equal(homeSystemOf(null, stops, systemOf), HEK)
  assert.equal(homeSystemOf({ id: 1035000000001, type: null }, stops, systemOf), HEK) // an unplaced structure falls through
  assert.equal(homeSystemOf(null, [stop(null, 50)], systemOf), null)
})

test('a blurb is cut to its first sentence', () => {
  assert.equal(
    firstSentence('The Brutors suffered the worst. Many are still enslaved.'),
    'The Brutors suffered the worst.'
  )
  assert.equal(firstSentence('No full stop here'), 'No full stop here')
  assert.equal(
    firstSentence('Paragon was founded by EverMore (est. 2023) as a luxury service.'),
    'Paragon was founded by EverMore (est.'
  )
  assert.equal(firstSentence('   '), null)
  assert.equal(firstSentence(null), null)
})

test('stations with named people come first, people are CEOs then agents, lists are capped', () => {
  const stations = Array.from({ length: 12 }, (_, i) => ({
    stationID: 60000000 + i,
    name: `Station ${i}`,
    ownerCorporationID: i % 2 === 0 ? 1000049 : null,
  }))
  const out = pickSurroundings({
    stations,
    corporations: { 1000049: { name: 'Brutor Tribe', description: 'The Brutors suffered the worst. More.' } },
    people: [
      { name: 'Vodber Svaken', stationID: 60000003, ceo: false, agent: true },
      { name: 'Karin Midular', stationID: 60000003, ceo: true, agent: false },
      { name: 'A', stationID: 60000003, ceo: false, agent: false },
      { name: 'B', stationID: 60000003, ceo: false, agent: true },
    ],
    planets: Array.from({ length: 9 }, (_, i) => ({
      name: `P${i}`,
      systemName: 'Rens',
      jumps: i < 3 ? (1 as const) : (0 as const),
    })),
  })
  assert.equal(out.stations.length, MAX_STATIONS)
  assert.equal(out.stations[0].stationID, 60000003)
  assert.deepEqual(
    out.stations[0].people.map((p) => [p.name, p.role]),
    [
      ['Karin Midular', 'ceo'],
      ['Vodber Svaken', 'agent'],
      ['B', 'agent'],
    ]
  )
  assert.equal(out.stations[1].corporation, 'Brutor Tribe')
  assert.equal(out.stations[1].about, 'The Brutors suffered the worst.')
  assert.equal(out.stations.find((s) => s.stationID === 60000001)?.corporation, null)
  assert.equal(out.temperate_planets.length, MAX_PLANETS)
  assert.ok(out.temperate_planets.slice(0, 6).every((p) => p.jumps === 0))
})
