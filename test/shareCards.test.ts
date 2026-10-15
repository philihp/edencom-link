// Unit coverage for the link-preview cards of the share pages beyond ships and
// containers: a saved fitting, a blueprint library, a corpse collection and a
// Link. Only their pure halves — what they draw and how the chat embed reads.
import assert from 'node:assert/strict'
import test from 'node:test'

import { bposDescription, bpoStacks, uniqueOriginalsText } from '../src/app/bpos/[name]/card/cardModel.ts'
import {
  corpseCountText,
  corpsesDescription,
  corpseStacks,
  NEW_WINDOW_MS,
  pilotFromName,
  toCorpse,
} from '../src/app/corpses/corpse.ts'
import { fittingDescription } from '../src/app/fitting/[characterId]/[fittingId]/card/cardModel.ts'
import { linkDescription, linkSubtitle } from '../src/app/link/[id]/card/cardModel.ts'
import type { SdeType } from '../src/sdeTypes.ts'

const type = (typeID: number, metaGroupID: number | null = 1): SdeType => ({
  typeID,
  name: `Type ${typeID}`,
  groupID: 0,
  categoryID: 9,
  groupName: null,
  categoryName: null,
  raceID: null,
  metaGroupID,
  volume: null,
})

test('a fitting embed names the hull, who saved it, the slots and the cost', () => {
  const row = (label: string, n: number) => ({
    label,
    icons: Array.from({ length: n }, (_, i) => ({ typeId: i, count: 1, color: '#fff' })),
  })
  assert.equal(
    fittingDescription('Drake', 'Battlecruiser', 'Sir Cuddles', [row('High', 7), row('Mid', 5)], {
      sell: 120_000_000,
      unpriced: 0,
    }),
    'Drake (Battlecruiser) fitting, saved by Sir Cuddles. High 7 · Mid 5. Estimated cost 120m ISK.'
  )
  assert.equal(
    fittingDescription('Ibis', null, 'Sir Cuddles', [], { sell: null, unpriced: 1 }),
    'Ibis fitting, saved by Sir Cuddles.'
  )
})

test('a blueprint library folds ME/TE variants into one icon per type, largest first', () => {
  const entries = [
    { typeId: 20, materialEfficiency: 10, timeEfficiency: 20, quantity: 1 },
    { typeId: 10, materialEfficiency: 0, timeEfficiency: 0, quantity: 2 },
    { typeId: 20, materialEfficiency: 0, timeEfficiency: 0, quantity: 3 },
    { typeId: 30, materialEfficiency: 0, timeEfficiency: 0, quantity: 2 },
  ]
  const stacks = bpoStacks(entries, { 10: type(10), 20: type(20, 2), 30: type(30) })
  assert.deepEqual(
    stacks.map((s) => [s.typeId, s.count, s.variation]),
    [
      [20, 4, 'bp'],
      [10, 2, 'bp'],
      [30, 2, 'bp'],
    ]
  )
  assert.equal(stacks[0].color, '#f0a53a')
})

test('a blueprint library embed counts unique and total originals', () => {
  assert.equal(uniqueOriginalsText(1), '1 unique original')
  assert.equal(
    bposDescription('Sir Cuddles', 3, 6),
    'Blueprint originals held by Sir Cuddles: 3 unique originals, 6 in total.'
  )
  assert.equal(bposDescription('Sir Cuddles', 2, 2), 'Blueprint originals held by Sir Cuddles: 2 unique originals.')
  assert.equal(bposDescription('Sir Cuddles', 0, 0), 'Sir Cuddles holds no blueprint originals.')
})

test('a corpse takes its pilot from the asset name and is new for two days', () => {
  assert.equal(pilotFromName("Sir Cuddles's Frozen Corpse"), 'Sir Cuddles')
  assert.equal(pilotFromName('Sir Cuddles’s frozen corpse'), 'Sir Cuddles')
  assert.equal(pilotFromName('  '), null)
  const now = Date.parse('2026-10-15T00:00:00Z')
  const row = (validFrom: string | null) => ({ item_id: 1, type_id: 2, name: null, valid_from: validFrom })
  assert.equal(toCorpse(row(new Date(now - NEW_WINDOW_MS + 1000).toISOString()), now).isNew, true)
  assert.equal(toCorpse(row(new Date(now - NEW_WINDOW_MS - 1000).toISOString()), now).isNew, false)
  assert.equal(toCorpse(row(null), now).isNew, false)
})

test('a corpse collection card stacks by type and says how many are new', () => {
  const corpse = (typeId: number, isNew = false) => ({ itemId: '1', typeId, pilot: null, isNew })
  const corpses = [corpse(2), corpse(1, true), corpse(2), corpse(1), corpse(2)]
  assert.deepEqual(
    corpseStacks(corpses).map((s) => [s.typeId, s.count]),
    [
      [2, 3],
      [1, 2],
    ]
  )
  assert.equal(corpseCountText(1), '1 corpse')
  assert.equal(
    corpsesDescription('Sir Cuddles', corpses),
    'The frozen corpses Sir Cuddles keeps. 5 corpses. 1 new in the last two days.'
  )
  assert.equal(corpsesDescription(null, []), 'A collection of frozen corpses. None yet.')
})

test('a Link card says what the Link reads, without running it', () => {
  assert.equal(linkSubtitle('assets'), 'Data Link · assets')
  assert.equal(linkSubtitle(null), 'Data Link')
  assert.equal(
    linkDescription('Jita stock', 'assets'),
    'Jita stock: a live Edencom Link over assets. Open it for current results.'
  )
})
