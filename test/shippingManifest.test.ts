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

// A count in front of the name, with no "x", is how people actually write a
// shopping list. Reading "25000 Construction Blocks" as a single item named
// that is what sent the whole string to the appraiser, which fuzzily matched
// it to a different item entirely and priced one of it.
test('a bare leading count is a quantity', () => {
  const { lines } = parseManifest('25000 Construction Blocks\n1000 x Tritanium\n12 Rifter')
  assert.deepEqual(lines, [
    { name: 'Construction Blocks', quantity: 25000 },
    { name: 'Tritanium', quantity: 1000 },
    { name: 'Rifter', quantity: 12 },
  ])
})

test('names that start with digits are not eaten by the leading count', () => {
  // The digits are glued to the letters in every one of these, and it is that
  // missing space — not a list of exceptions — that keeps them whole.
  const { lines } = parseManifest(
    ['425mm AutoCannon II', '1600mm Steel Plates II', '10MN Afterburner II', '800mm Repeating Cannon II'].join('\n')
  )
  assert.deepEqual(
    lines.map((l) => l.quantity),
    [1, 1, 1, 1]
  )
  assert.equal(lines[0].name, '425mm AutoCannon II')
  assert.equal(lines[2].name, '10MN Afterburner II')
})

test('an item starting with x survives an optional-x leading count', () => {
  const { lines } = parseManifest('10 Xenon Gas\n10 x Xenon Gas')
  assert.deepEqual(lines, [{ name: 'Xenon Gas', quantity: 20 }])
})

test('a trailing count still wins over a leading one', () => {
  // "1600mm" is part of the name; the 5 at the end is the count.
  const { lines } = parseManifest('1600mm Steel Plates II 5')
  assert.deepEqual(lines, [{ name: '1600mm Steel Plates II', quantity: 5 }])
})
