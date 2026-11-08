import assert from 'node:assert/strict'
import { test } from 'node:test'

import { locationKind, marketLines } from '../src/app/industry/planner/market/marketRows.ts'

const HOME = 10000060
const JITA = 10000002
const regions = { homeRegionId: HOME, jitaRegionId: JITA }

test('marketLines folds stock, jobs and listings per type and region', () => {
  const lines = marketLines(
    [
      { typeId: 648, backup: 0, home: 20, jita: 100 },
      { typeId: 34, backup: 2000, home: 0, jita: 0 },
    ],
    [
      { typeId: 648, quantity: 30 },
      { typeId: 648, quantity: 19 },
      { typeId: 99, quantity: 5 },
    ],
    [
      { typeId: 648, regionId: HOME, quantity: 7 },
      { typeId: 648, regionId: HOME, quantity: 3 },
      { typeId: 648, regionId: JITA, quantity: 50 },
      { typeId: 648, regionId: 10000001, quantity: 4 },
      { typeId: 648, regionId: null, quantity: 4 },
    ],
    [
      { typeId: 648, units: 30 },
      { typeId: 34, units: 1 },
    ],
    new Map([[648, 19_210_000]]),
    regions
  )
  assert.deepEqual(lines, [
    {
      typeId: 648,
      homeTarget: 20,
      jitaTarget: 100,
      inventory: 49,
      inFlight: 30,
      homeListed: 10,
      jitaListed: 50,
      homeShare: 0.5,
      jitaShare: 0.5,
      importPrice: 19_210_000,
    },
    {
      typeId: 34,
      homeTarget: 0,
      jitaTarget: 0,
      inventory: 0,
      inFlight: 1,
      homeListed: 0,
      jitaListed: 0,
      homeShare: null,
      jitaShare: null,
      importPrice: null,
    },
  ])
})

test('marketLines keeps the target order and answers nothing for no targets', () => {
  assert.deepEqual(marketLines([], [], [], [], new Map(), regions), [])
})

test('locationKind reads a station, a structure, or neither from the id range', () => {
  assert.equal(locationKind(60003760), 'station')
  assert.equal(locationKind(1035466617946), 'structure')
  assert.equal(locationKind(30000142), 'other')
})
