// Unit coverage for the shipping calculator's paste parser. What's worth
// pinning is that the three shapes a player can paste — an inventory copy, a
// multibuy list, a bare list of names — all land as the same lines, and that
// nothing in a name is mistaken for a quantity: an item silently priced 1000×
// would quote a freighter's worth of freight for a crate of ammo.
import assert from 'node:assert/strict'
import test from 'node:test'

import { parseManifest } from '../src/app/asset/shipping/manifest.ts'

test('an inventory paste takes its quantity from the second column', () => {
  const { lines } = parseManifest(
    ['Tritanium\t1,000\tMineral\tAsteroid\t0.01 m3', 'Rifter\t\tFrigate\tShip\t2,500 m3'].join('\n')
  )
  assert.deepEqual(lines, [
    { name: 'Tritanium', quantity: 1000 },
    // An assembled ship pastes with an empty quantity column, meaning one.
    { name: 'Rifter', quantity: 1 },
  ])
})

test('multibuy quantities are read trailing, x-prefixed, or leading', () => {
  const { lines } = parseManifest(
    ['Tritanium 1000', 'Nanite Repair Paste x25', '12x Rifter', 'Damage Control II'].join('\n')
  )
  assert.deepEqual(lines, [
    { name: 'Tritanium', quantity: 1000 },
    { name: 'Nanite Repair Paste', quantity: 25 },
    { name: 'Rifter', quantity: 12 },
    { name: 'Damage Control II', quantity: 1 },
  ])
})

test('thousands separators are stripped whatever the client locale used', () => {
  const { lines } = parseManifest("Tritanium 1,234\nPyerite 1'234\nMexallon 1 234")
  assert.deepEqual(
    lines.map((l) => l.quantity),
    [1234, 1234, 1234]
  )
})

test('a name ending in digits keeps them', () => {
  // The hyphen is what saves it: a quantity is always preceded by whitespace.
  const { lines } = parseManifest("Zainou 'Gypsy' KNS-1000\n425mm AutoCannon II")
  assert.deepEqual(lines, [
    { name: "Zainou 'Gypsy' KNS-1000", quantity: 1 },
    { name: '425mm AutoCannon II', quantity: 1 },
  ])
})

test('repeated items merge, keeping the first spelling', () => {
  const { lines } = parseManifest('Tritanium 100\ntritanium 50\nTRITANIUM x1')
  assert.deepEqual(lines, [{ name: 'Tritanium', quantity: 151 }])
})

test('blank lines vanish and a fitting header is reported as ignored', () => {
  const { lines, ignored } = parseManifest('[Rifter, Solo]\n\n  \nDamage Control II\n')
  assert.deepEqual(lines, [{ name: 'Damage Control II', quantity: 1 }])
  assert.deepEqual(ignored, ['[Rifter, Solo]'])
})

test('nothing pasted is no lines at all', () => {
  assert.deepEqual(parseManifest('   \n\n').lines, [])
})
