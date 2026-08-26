// The EFT export at the foot of a fitting page (src/app/fitting/eft.ts). The
// text is the interoperability contract — the in-game fitting window imports
// it by counting blank-line-separated blocks, with no labels to go on — so the
// exact shape is worth pinning.
import assert from 'node:assert/strict'
import test from 'node:test'

import { toEft, type EftType } from '../src/app/fitting/eft.ts'

const types: Record<number, EftType> = {
  587: { name: 'Rifter', categoryID: 6 },
  2873: { name: 'Nanofiber Internal Structure II', categoryID: 7 },
  5973: { name: '5MN Y-T8 Compact Microwarpdrive', categoryID: 7 },
  2977: { name: '200mm AutoCannon II', categoryID: 7 },
  21896: { name: 'Republic Fleet EMP S', categoryID: 8 },
  31153: { name: 'Small Projectile Burst Aerator II', categoryID: 7 },
  2488: { name: 'Warrior II', categoryID: 18 },
  28668: { name: 'Nanite Repair Paste', categoryID: 4 },
}

test('toEft writes the blocks in the importer’s order', () => {
  const eft = toEft(
    {
      name: 'Shield Rifter',
      ship_type_id: 587,
      items: [
        { type_id: 2977, flag: 'HiSlot0', quantity: 1 },
        // A charge shares its module's flag — EFT joins the two on one line.
        { type_id: 21896, flag: 'HiSlot0', quantity: 100 },
        { type_id: 5973, flag: 'MedSlot0', quantity: 1 },
        { type_id: 2873, flag: 'LoSlot0', quantity: 1 },
        { type_id: 31153, flag: 'RigSlot0', quantity: 1 },
        { type_id: 2488, flag: 'DroneBay', quantity: 2 },
        { type_id: 28668, flag: 'Cargo', quantity: 50 },
      ],
    },
    types
  )

  assert.equal(
    eft,
    [
      '[Rifter, Shield Rifter]',
      '',
      'Nanofiber Internal Structure II',
      '',
      '5MN Y-T8 Compact Microwarpdrive',
      '',
      '200mm AutoCannon II, Republic Fleet EMP S',
      '',
      'Small Projectile Burst Aerator II',
      '',
      'Warrior II x2',
      '',
      'Nanite Repair Paste x50',
    ].join('\n')
  )
})

test('a gap below the highest fitted slot becomes an empty-slot placeholder', () => {
  // LoSlot1 is unfitted between two fitted lows: the importer counts lines, so
  // the hole has to be written out or the third module lands in slot two.
  const eft = toEft(
    {
      name: null,
      ship_type_id: 587,
      items: [
        { type_id: 2873, flag: 'LoSlot0', quantity: 1 },
        { type_id: 2873, flag: 'LoSlot2', quantity: 1 },
      ],
    },
    types
  )

  // No fit name falls back to the hull, the way an unnamed fit exports.
  assert.equal(
    eft,
    [
      '[Rifter, Rifter]',
      '',
      'Nanofiber Internal Structure II',
      '[Empty Low slot]',
      'Nanofiber Internal Structure II',
    ].join('\n')
  )
})

test('identical bay stacks fold into one quantity line', () => {
  const eft = toEft(
    {
      name: 'Drones',
      ship_type_id: 587,
      items: [
        { type_id: 2488, flag: 'DroneBay', quantity: 2 },
        { type_id: 2488, flag: 'DroneBay', quantity: 3 },
      ],
    },
    types
  )
  assert.equal(eft, ['[Rifter, Drones]', '', 'Warrior II x5'].join('\n'))
})

test('an unmirrored type still exports, rather than dropping a slot', () => {
  const eft = toEft(
    { name: 'Mystery', ship_type_id: 587, items: [{ type_id: 999999, flag: 'HiSlot0', quantity: 1 }] },
    types
  )
  assert.equal(eft, ['[Rifter, Mystery]', '', '[Unknown type 999999]'].join('\n'))
})
