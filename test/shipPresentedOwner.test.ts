// Unit coverage for what a share recipient may see when a share shows the
// account's main as a ship's owner (src/app/ship/[itemId]/presentedOwner.ts).
// The failure this guards is silent and costly: a page that draws the main's
// name but still carries the holder's registration uuid, or a hull still named
// "<holder>'s Redeemer", hands a locator the character the share hid.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PRESENTED_OWNER_ID,
  UNNAMED_OWNER,
  hideHolder,
  labelWithoutHolder,
  withoutHolderName,
} from '../src/app/ship/[itemId]/presentedOwner.ts'

const HOLDER = 'Quuixote'
const HOLDER_UUID = '78305b2c-738b-417d-a811-d8fc1a37edd3'

test('a hull with the game’s default name loses it', () => {
  assert.equal(withoutHolderName(HOLDER)("Quuixote's Redeemer"), null)
})

test('the holder’s name is found in any case and anywhere in the name', () => {
  assert.equal(withoutHolderName(HOLDER)('cargo for QUUIXOTE'), null)
  assert.equal(withoutHolderName(HOLDER)('quuixote jump can'), null)
})

test('a name that does not carry the holder’s name stays', () => {
  assert.equal(withoutHolderName(HOLDER)('Katima Katsuo'), 'Katima Katsuo')
  assert.equal(withoutHolderName(HOLDER)(null), null)
})

test('no holder name to look for leaves names alone', () => {
  assert.equal(withoutHolderName(null)("Quuixote's Redeemer"), "Quuixote's Redeemer")
  assert.equal(withoutHolderName('  ')("Quuixote's Redeemer"), "Quuixote's Redeemer")
})

test('a row loses the holder’s registration uuid and a name carrying theirs', () => {
  const row = { item_id: 1, type_id: 22428, name: "Quuixote's Redeemer", registration_id: HOLDER_UUID }
  const shown = hideHolder(HOLDER)(row)
  assert.equal(shown.registration_id, PRESENTED_OWNER_ID)
  assert.equal(shown.name, null)
  assert.equal(shown.item_id, 1)
  assert.ok(!JSON.stringify(shown).includes(HOLDER_UUID), 'the uuid must not survive anywhere in the row')
})

test('an asset browser row loses the holder’s owner id', () => {
  const shown = hideHolder(HOLDER)({ item_id: 3, type_id: 17366, name: 'Quuixote hauling can', owner_id: HOLDER_UUID })
  assert.equal(shown.owner_id, PRESENTED_OWNER_ID)
  assert.equal(shown.name, null)
})

test('a row without a registration id does not gain one', () => {
  const shown = hideHolder(HOLDER)({ item_id: 2, type_id: 34, name: null })
  assert.equal('registration_id' in shown, false)
  assert.equal('owner_id' in shown, false)
})

test('a breadcrumb that names the holder reads as a container', () => {
  assert.equal(labelWithoutHolder(HOLDER)("Quuixote's Station Container"), 'Container')
  assert.equal(labelWithoutHolder(HOLDER)('Jita IV - Moon 4'), 'Jita IV - Moon 4')
})

test('the fallback owner names no one and shows no portrait', () => {
  assert.equal(UNNAMED_OWNER.portrait, null)
  assert.notEqual(UNNAMED_OWNER.name, HOLDER)
})
