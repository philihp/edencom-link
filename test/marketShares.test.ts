// Unit coverage for the market page's share seam: the donut data per
// counterparty and per item type, the universe_name kind, and the image URL.
import assert from 'node:assert/strict'
import test from 'node:test'

import { counterpartyImage, counterpartyShare, parseKind, typeShare } from '../src/app/market/shares.ts'

const totals = { quantity: 1, count: 1 }

test('counterpartyShare names each counterparty, else shows the raw id', () => {
  assert.deepEqual(
    counterpartyShare({ 7: 'Alice' })([
      { clientId: 7, total: 30, ...totals },
      { clientId: 9, total: 10, ...totals },
    ]),
    [
      { key: '7', label: 'Alice', value: 30 },
      { key: '9', label: '#9', value: 10 },
    ]
  )
})

test('typeShare names each type, else shows the raw id', () => {
  assert.deepEqual(
    typeShare({ 34: 'Tritanium' })([
      { typeId: 34, total: 5, ...totals },
      { typeId: 35, total: 2, ...totals },
    ]),
    [
      { key: '34', label: 'Tritanium', value: 5 },
      { key: '35', label: '#35', value: 2 },
    ]
  )
})

test('both give an empty list for no rows', () => {
  assert.deepEqual(counterpartyShare({})([]), [])
  assert.deepEqual(typeShare({})([]), [])
})

test('parseKind accepts the three kinds and refuses the rest', () => {
  assert.equal(parseKind('character'), 'character')
  assert.equal(parseKind('corporation'), 'corporation')
  assert.equal(parseKind('alliance'), 'alliance')
  assert.equal(parseKind('faction'), undefined)
  assert.equal(parseKind(''), undefined)
})

test('counterpartyImage gives the portrait or the logo, and null for an unknown kind', () => {
  assert.equal(
    counterpartyImage('character', 90000001),
    'https://images.evetech.net/characters/90000001/portrait?size=64'
  )
  assert.equal(
    counterpartyImage('corporation', 98000001, 32),
    'https://images.evetech.net/corporations/98000001/logo?size=32'
  )
  assert.equal(counterpartyImage('alliance', 99000001), 'https://images.evetech.net/alliances/99000001/logo?size=64')
  assert.equal(counterpartyImage(undefined, 1), null)
})
