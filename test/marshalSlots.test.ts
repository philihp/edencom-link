// Unit coverage for the slot arithmetic behind the marshal controls
// (src/app/fitting/marshal/slots.ts): used/free per character, and the
// unmarshal picker's order and disabled states.
import assert from 'node:assert/strict'
import test from 'node:test'

import { FITTING_SLOTS as CANONICAL } from '../src/fittingArchive.ts'
import { FITTING_SLOTS, slotMeter, slotUsage, targetLabel, unmarshalTargets } from '../src/app/fitting/marshal/slots.ts'

const main = { registrationId: 'r-main', characterId: '1001', name: 'Philihp Hallgren' }
const alt = { registrationId: 'r-alt', characterId: '2002', name: 'Alt Pilot' }
const fresh = { registrationId: 'r-fresh', characterId: '3003', name: 'Brand New' }

const rows = (registrationId: string, n: number) =>
  Array.from({ length: n }, () => ({ registration_id: registrationId }))

test('slotUsage counts rows per character against the cap, listing characters with no fits too', () => {
  const usage = slotUsage([...rows('r-main', 3), ...rows('r-alt', 5)], [main, alt, fresh], new Set(['r-main']), 5)
  assert.deepEqual(usage, [
    { ...main, used: 3, free: 2, full: false, writable: true },
    { ...alt, used: 5, free: 0, full: true, writable: false },
    { ...fresh, used: 0, free: 5, full: false, writable: false },
  ])
})

test('the default capacity is EVE’s 500', () => {
  const [u] = slotUsage(rows('r-main', 487), [main], new Set())
  assert.equal(u.free, 13)
  assert.equal(u.full, false)
})

test('free never goes negative when the mirror holds more rows than the cap', () => {
  // Two extracts racing a client-side save can leave an extra open row for a
  // moment; the meter must not read "-1 free".
  const [u] = slotUsage(rows('r-main', 6), [main], new Set(), 5)
  assert.equal(u.free, 0)
  assert.equal(u.full, true)
})

test('unmarshalTargets: emptiest first, full or unwritable disabled with a reason, the source left out', () => {
  const usage = slotUsage(
    [...rows('r-main', 3), ...rows('r-alt', 5)],
    [main, alt, fresh],
    new Set(['r-main', 'r-alt']),
    5
  )
  const targets = unmarshalTargets(usage, 'r-main')
  assert.deepEqual(
    targets.map((t) => [t.name, t.disabled, t.reason]),
    [
      ['Brand New', true, 'not writable'],
      ['Alt Pilot', true, 'full'],
    ]
  )
  // Without an exclusion the source is a target like any other.
  assert.deepEqual(
    unmarshalTargets(usage).map((t) => t.name),
    ['Brand New', 'Philihp Hallgren', 'Alt Pilot']
  )
})

test('ties on free slots break by name so the picker is stable', () => {
  const usage = slotUsage([], [alt, main], new Set(['r-main', 'r-alt']))
  assert.deepEqual(
    unmarshalTargets(usage).map((t) => t.name),
    ['Alt Pilot', 'Philihp Hallgren']
  )
})

test('full wins over not-writable as the reason shown', () => {
  const [u] = slotUsage(rows('r-alt', 5), [alt], new Set(), 5)
  assert.equal(unmarshalTargets([u])[0].reason, 'full')
})

test('slotMeter reads Pilot · used / cap, naming an unnamed character by id', () => {
  const [u] = slotUsage(rows('r-main', 487), [main], new Set())
  assert.equal(slotMeter(u), 'Philihp Hallgren · 487 / 500')
  const [v] = slotUsage([], [{ ...fresh, name: null }], new Set())
  assert.equal(slotMeter(v), 'Character #3003 · 0 / 500')
})

test('targetLabel names the character, the count against the cap, and why it is disabled', () => {
  const usage = slotUsage([...rows('r-main', 3), ...rows('r-alt', 5)], [main, alt, fresh], new Set(['r-main']), 5)
  const [a, b, c] = unmarshalTargets(usage).map((t) => targetLabel(t, 5))
  assert.equal(a, 'Brand New · 0 / 5 — no write scope')
  assert.equal(b, 'Philihp Hallgren · 3 / 5')
  assert.equal(c, 'Alt Pilot · 5 / 5 — full')
})

test('the restated cap is the archive module’s canonical one', () => {
  assert.equal(FITTING_SLOTS, CANONICAL)
})
