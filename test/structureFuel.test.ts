// Unit coverage for the pure low-fuel detection seam
// (docs/discord-bot/07-structure-fuel-alerts.md). The crossing rule is the part
// a live structure can't be arranged to exercise on demand — and the part with
// a real trap in it: while nobody refuels, the stored fuel timer and the fresh
// one are the same instant, so a naive "is it low now, was it high before"
// written against a single clock never fires at all. These tests pin that the
// previous reading is judged against the time it was taken.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  composeFuelPing,
  isNewlyLowFuel,
  LOW_FUEL_THRESHOLD_MS,
  planAllFuelNotifications,
  planFuelNotifications,
  structureFuelSource,
} from '../src/jobs/structureFuel.js'

const now = new Date('2026-08-12T12:00:00Z')
const day = 24 * 60 * 60 * 1000
const at = (offsetMs: number) => new Date(now.getTime() + offsetMs).toISOString()

const channels = [
  { id: 'chan-a', user_id: 'user-1' },
  { id: 'chan-b', user_id: 'user-2' },
]

test('threshold is seven days', () => {
  assert.equal(LOW_FUEL_THRESHOLD_MS, 7 * day)
})

test('crossing: yesterday above the line, today below it', () => {
  // The no-refuel case: fuel_expires is unchanged, only the clock moved.
  const fuelExpires = at(6.5 * day)
  assert.equal(
    isNewlyLowFuel({
      prev: { fuel_expires: fuelExpires, updated_at: at(-day) }, // 7.5 days left when read
      next: { fuel_expires: fuelExpires }, // 6.5 days left now
      now,
    }),
    true
  )
})

test('quiet: still low the next run, with no refuel in between', () => {
  const fuelExpires = at(5.5 * day)
  assert.equal(
    isNewlyLowFuel({
      prev: { fuel_expires: fuelExpires, updated_at: at(-day) }, // already 6.5 days left
      next: { fuel_expires: fuelExpires },
      now,
    }),
    false
  )
})

test('quiet: comfortably fuelled', () => {
  assert.equal(
    isNewlyLowFuel({
      prev: { fuel_expires: at(31 * day), updated_at: at(-day) },
      next: { fuel_expires: at(30 * day) },
      now,
    }),
    false
  )
})

test('re-arms: refuelled above the line, then drained back under it', () => {
  const refuelled = { fuel_expires: at(30 * day), updated_at: at(-day) }
  // Straight after the refuel, nothing to say.
  assert.equal(isNewlyLowFuel({ prev: refuelled, next: { fuel_expires: at(30 * day) }, now }), false)
  // Weeks later it crosses again, and the alert fires a second time.
  const drained = at(6.5 * day)
  assert.equal(
    isNewlyLowFuel({
      prev: { fuel_expires: drained, updated_at: at(-day) }, // 7.5 days left when read
      next: { fuel_expires: drained },
      now,
    }),
    true
  )
})

test('first sighting already low alerts once', () => {
  assert.equal(isNewlyLowFuel({ prev: null, next: { fuel_expires: at(2 * day) }, now }), true)
})

test('no fuel timer at all is silent', () => {
  assert.equal(isNewlyLowFuel({ prev: null, next: { fuel_expires: null }, now }), false)
  assert.equal(isNewlyLowFuel({ prev: null, next: {}, now }), false)
})

test('already dry is silent — this alert warns, it does not write obituaries', () => {
  assert.equal(isNewlyLowFuel({ prev: null, next: { fuel_expires: at(-day) }, now }), false)
})

test('exactly at the threshold counts as low', () => {
  assert.equal(
    isNewlyLowFuel({
      prev: { fuel_expires: at(7 * day), updated_at: at(-day) },
      next: { fuel_expires: at(7 * day) },
      now,
    }),
    true
  )
})

test('source key is per structure per distinct timer', () => {
  const fuelExpires = at(3 * day)
  const unix = Math.floor(new Date(fuelExpires).getTime() / 1000)
  assert.equal(structureFuelSource(1035466617946, fuelExpires), `structure-fuel:1035466617946:${unix}`)
  // A refuel moves the timer, so the source changes and the alert can fire again.
  assert.notEqual(structureFuelSource(1035466617946, fuelExpires), structureFuelSource(1035466617946, at(30 * day)))
})

test('ping names the structure, its system, and the countdown', () => {
  const fuelExpires = at(3 * day)
  const unix = Math.floor(new Date(fuelExpires).getTime() / 1000)
  assert.deepEqual(composeFuelPing({ name: 'The Vault', systemName: 'RXA-W1', structureId: 42, fuelExpires }), {
    subject: 'Structure Fuel Low',
    body: `Structure Low On Fuel - The Vault (RXA-W1) runs dry at <t:${unix}:s> <t:${unix}:R>`,
  })
})

test('ping does not repeat a system already in the structure name', () => {
  const { body } = composeFuelPing({
    name: 'RXA-W1 - The Vault',
    systemName: 'RXA-W1',
    structureId: 42,
    fuelExpires: at(3 * day),
  })
  assert.match(body, /- RXA-W1 - The Vault runs dry/)
})

test('ping falls back to the raw id when ESI gave no name', () => {
  const { body } = composeFuelPing({ name: null, systemName: null, structureId: 42, fuelExpires: at(3 * day) })
  assert.match(body, /- structure 42 runs dry/)
})

test('one row per listening channel, each attributed to its own account', () => {
  const fuelExpires = at(6.5 * day)
  const rows = planFuelNotifications({
    structure: { structure_id: 42, system_id: 30000142, name: 'The Vault', fuel_expires: fuelExpires },
    prev: { fuel_expires: fuelExpires, updated_at: at(-day) },
    systemName: 'Jita',
    channels,
    now,
  })
  assert.equal(rows.length, 2)
  assert.deepEqual(
    rows.map((r) => [r.user_id, r.discord_channel_id]),
    [
      ['user-1', 'chan-a'],
      ['user-2', 'chan-b'],
    ]
  )
  assert.equal(rows[0].transport, 'discord')
  assert.equal(rows[0].source, structureFuelSource(42, fuelExpires))
  assert.equal(rows[0].scheduled_at, now.toISOString())
})

test('a structure that did not cross produces nothing', () => {
  assert.deepEqual(
    planFuelNotifications({
      structure: { structure_id: 42, system_id: 30000142, name: 'The Vault', fuel_expires: at(30 * day) },
      prev: { fuel_expires: at(31 * day), updated_at: at(-day) },
      systemName: 'Jita',
      channels,
      now,
    }),
    []
  )
})

test('a run plans only its crossing structures', () => {
  const crossing = at(6.5 * day)
  const rows = planAllFuelNotifications({
    structures: [
      { structure_id: 42, system_id: 30000142, name: 'The Vault', fuel_expires: crossing },
      { structure_id: 43, system_id: 30000142, name: 'The Annex', fuel_expires: at(30 * day) },
      { structure_id: 44, system_id: 30000999, name: null, fuel_expires: null },
    ],
    prevById: new Map([
      [42, { fuel_expires: crossing, updated_at: at(-day) }],
      [43, { fuel_expires: at(31 * day), updated_at: at(-day) }],
    ]),
    systemNames: new Map([[30000142, 'Jita']]),
    channels,
    now,
  })
  // Only structure 42, fanned out across both channels.
  assert.equal(rows.length, 2)
  assert.ok(rows.every((r) => r.source === structureFuelSource(42, crossing)))
  assert.match(rows[0].body, /The Vault \(Jita\)/)
})
