// The native voice per kind of item (src/app/ship/memory/nativeVoice.ts,
// docs/ship-memory.md "Extension: every singleton" → "The voice,
// generalised"): the kind read from the SDE category, a ship keeping its
// accent and register, a blueprint's register read from its research, a
// high-slot module the thug and every other module the droid.
import assert from 'node:assert/strict'
import test from 'node:test'

import { voiceOf } from '../src/app/ship/memory/accent.ts'
import { blueprintRegister, isHighSlot, kindOf, nativeVoiceOf } from '../src/app/ship/memory/nativeVoice.ts'

test('the kind comes from the SDE category, and a Celestial is a container only when its group says so', () => {
  assert.equal(kindOf({ categoryID: 6, groupName: 'Cruiser' }), 'ship')
  assert.equal(kindOf({ categoryID: 9, groupName: 'Cruiser Blueprint' }), 'blueprint')
  assert.equal(kindOf({ categoryID: 7, groupName: 'Energy Weapon' }), 'module')
  assert.equal(kindOf({ categoryID: 2, groupName: 'Secure Cargo Container' }), 'container')
  assert.equal(kindOf({ categoryID: 2, groupName: 'Planet' }), 'item')
  assert.equal(kindOf({ categoryID: 18, groupName: 'Combat Drone' }), 'item')
  assert.equal(kindOf({ categoryID: null, groupName: null }), 'item')
})

test('a high slot is HiSlot0..7 and nothing else', () => {
  assert.equal(isHighSlot('HiSlot0'), true)
  assert.equal(isHighSlot('HiSlot7'), true)
  assert.equal(isHighSlot('MedSlot0'), false)
  assert.equal(isHighSlot('Cargo'), false)
  assert.equal(isHighSlot(null), false)
})

test('a ship keeps the accent and register the ship chapter gave it', () => {
  const v = nativeVoiceOf({ kind: 'ship', factionId: 500010, raceId: 1, groupName: 'Cruiser' })
  const accent = voiceOf({ factionId: 500010, raceId: 1 })
  assert.equal(v.accent, accent.accent)
  assert.equal(v.origin, accent.label)
  assert.equal(v.placed_by, 'faction')
  assert.equal(v.register_class, 'Cruiser, battlecruiser')
})

test("a blueprint's register is its research", () => {
  assert.equal(blueprintRegister({ me: 10, te: 20 }).label, 'Fully researched')
  assert.equal(blueprintRegister({ me: 0, te: 0 }).label, 'Unresearched')
  assert.equal(blueprintRegister({ me: 7, te: 14 }).label, 'Mid-research')
  assert.equal(blueprintRegister(null).label, 'Unresearched')
  const v = nativeVoiceOf({
    kind: 'blueprint',
    factionId: null,
    raceId: null,
    groupName: 'Cruiser Blueprint',
    research: { me: 10, te: 20 },
  })
  assert.equal(v.placed_by, 'kind')
  assert.match(v.accent, /clerk/)
  assert.equal(v.register_class, 'Fully researched')
})

test('a module is a droid, a high-slot module the thug', () => {
  const low = nativeVoiceOf({
    kind: 'module',
    factionId: null,
    raceId: null,
    groupName: 'Armor Plate',
    flag: 'LoSlot1',
  })
  const high = nativeVoiceOf({
    kind: 'module',
    factionId: null,
    raceId: null,
    groupName: 'Energy Weapon',
    flag: 'HiSlot2',
  })
  const packaged = nativeVoiceOf({
    kind: 'module',
    factionId: null,
    raceId: null,
    groupName: 'Energy Weapon',
    flag: 'Hangar',
  })
  assert.match(low.accent, /droid/)
  assert.match(high.accent, /brutish/)
  assert.equal(high.origin, 'High-slot module')
  // Not fitted now: the droid, since the thug is a matter of the slot it sits in.
  assert.match(packaged.accent, /droid/)
})

test('a container is the foreman and anything else the plain droid', () => {
  assert.match(
    nativeVoiceOf({ kind: 'container', factionId: null, raceId: null, groupName: 'Cargo Container' }).accent,
    /foreman/
  )
  const drone = nativeVoiceOf({ kind: 'item', factionId: null, raceId: null, groupName: 'Combat Drone' })
  assert.match(drone.accent, /droid/)
  assert.equal(drone.register_class, 'Combat Drone')
})
