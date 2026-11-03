// The lingo a ship picks up from highsec (src/app/ship/memory/lingo.ts,
// docs/ship-memory.md "Ships in highsec"): dwell per region over the stops
// that resolve to a system in the band, regions of one empire added, the
// weight min(LINGO_CAP, days / 365 × LINGO_CAP). Small by design, and the
// band is a parameter.
import assert from 'node:assert/strict'
import test from 'node:test'

import type { Place, Stop } from '../src/app/ship/memory/dossier.ts'
import { HIGHSEC_MIN_SECURITY, LINGO_CAP, lingo, lingoWeight, regionDwell } from '../src/app/ship/memory/lingo.ts'

const JITA = 30000142 // The Forge, Caldari, 0.95
const RENS = 30002510 // Heimatar, Minmatar, 0.9
const HEK = 30002053 // Metropolis, Minmatar, 0.5 shown, 0.45 true
const AMAMAKE = 30002537 // Heimatar, 0.4 — lowsec
const Y_SYSTEM = 30004759 // Delve, no faction, null
const FORGE = 10000002
const HEIMATAR = 10000030
const METROPOLIS = 10000042
const DELVE = 10000060

const systems: Record<number, { security: number; regionId: number | null }> = {
  [JITA]: { security: 0.95, regionId: FORGE },
  [RENS]: { security: 0.9, regionId: HEIMATAR },
  [HEK]: { security: 0.45, regionId: METROPOLIS },
  [AMAMAKE]: { security: 0.4, regionId: HEIMATAR },
  [Y_SYSTEM]: { security: -0.6, regionId: DELVE },
}
const factions: Record<number, number> = { [FORGE]: 500001, [HEIMATAR]: 500002, [METROPOLIS]: 500002 }

// Stations are 60M ids; the fixture maps each to its system by hand, as the
// loader does through sde_station.
const STATION_SYSTEM: Record<number, number> = { 60003760: JITA, 60004588: RENS, 60005686: HEK, 60008494: AMAMAKE }
const systemOf = (p: Place): number | null =>
  p.type === 'solar_system' ? p.id : p.type === 'station' ? (STATION_SYSTEM[p.id] ?? null) : null
const systemInfo = (id: number) => systems[id] ?? null
const factionOf = (regionId: number) => factions[regionId] ?? null

const stop = (place: Place | null, days: number): Stop => ({
  place,
  parentId: null,
  arrived: '2026-01-01T00:00:00Z',
  departed: null,
  hours: days * 24,
})

test('the weight is a tenth of the accent curve: a year earns LINGO_CAP and no more', () => {
  assert.equal(lingoWeight(0), 0)
  assert.equal(Math.round(lingoWeight(182.5) * 1000) / 1000, 0.05)
  assert.equal(lingoWeight(365), LINGO_CAP)
  assert.equal(lingoWeight(1000), LINGO_CAP)
  assert.equal(lingoWeight(365, 0.5), 0.5)
})

test('dwell is summed per region over the stops in the band; lowsec, null and unplaced stops teach nothing', () => {
  const dwell = regionDwell(
    [
      stop({ id: 60003760, type: 'station' }, 10),
      stop({ id: JITA, type: 'solar_system' }, 5),
      stop({ id: 60004588, type: 'station' }, 20),
      stop({ id: 60008494, type: 'station' }, 30), // Amamake, 0.4
      stop({ id: Y_SYSTEM, type: 'solar_system' }, 100),
      stop({ id: 1035000000001, type: null }, 50), // a structure the resolver could not place
      stop(null, 7), // inside another item
    ],
    systemOf,
    systemInfo
  )
  assert.deepEqual(
    [...dwell.entries()],
    [
      [FORGE, 15],
      [HEIMATAR, 20],
    ]
  )
})

test('0.45 true security is highsec (shown as 0.5), and the band is a parameter', () => {
  const stops = [stop({ id: 60005686, type: 'station' }, 10)]
  assert.equal(regionDwell(stops, systemOf, systemInfo).get(METROPOLIS), 10)
  assert.equal(regionDwell(stops, systemOf, systemInfo, 0.5).get(METROPOLIS), undefined)
  assert.equal(HIGHSEC_MIN_SECURITY, 0.45)
})

test("regions of one empire add their days; the empires come heaviest first with the accent chart's voice", () => {
  const out = lingo(
    [
      stop({ id: 60004588, type: 'station' }, 100), // Heimatar, Minmatar
      stop({ id: 60005686, type: 'station' }, 265), // Metropolis, Minmatar
      stop({ id: 60003760, type: 'station' }, 36.5), // The Forge, Caldari
    ],
    systemOf,
    systemInfo,
    factionOf
  )
  assert.equal(out.length, 2)
  assert.equal(out[0].factionId, 500002)
  assert.equal(out[0].label, 'Minmatar Republic')
  assert.equal(out[0].from, 'faction')
  assert.deepEqual(out[0].regionIds.sort(), [HEIMATAR, METROPOLIS])
  assert.equal(out[0].days, 365)
  assert.equal(out[0].weight, LINGO_CAP)
  assert.equal(out[1].factionId, 500001)
  assert.equal(out[1].weight, 0.01)
})

test('a region the SDE gives no faction teaches nothing, and a lower cap scales every weight', () => {
  const unowned = lingo(
    [stop({ id: Y_SYSTEM, type: 'solar_system' }, 365)],
    systemOf,
    () => ({ security: 0.9, regionId: DELVE }),
    factionOf
  )
  assert.deepEqual(unowned, [])
  const halved = lingo([stop({ id: 60003760, type: 'station' }, 365)], systemOf, systemInfo, factionOf, { cap: 0.05 })
  assert.equal(halved[0].weight, 0.05)
})
