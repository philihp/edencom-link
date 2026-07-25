// Rig applicability: which Upwell rigs bonus which products. This is the seam
// behind /blueprint/[typeID], the rigs_for_blueprint MCP tool, and — the reason
// it needs testing — the structure_id path in blueprint_for_product, which used
// to apply whichever fitted ME rig had the highest tier regardless of whether
// it covered the product at all.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { rigAppliesToProduct, rigsForProduct } from '../src/app/blueprint/rigs.ts'

// Stable SDE ids, taken from src/app/blueprint/[typeID]/filters.ts.
const SHIP_CATEGORY = 6
const FRIGATE_GROUP = 25 // also carries the 'Small T1 Ships' filter
const CHARGE_CATEGORY = 8
const DRONE_CATEGORY = 18

// A group/category pair no filter covers, so nothing should bonus it.
const UNCOVERED_GROUP = -1
const UNCOVERED_CATEGORY = -1

test('a product in a covered category has bonusing rigs', () => {
  const rigs = rigsForProduct(FRIGATE_GROUP, SHIP_CATEGORY)
  assert.ok(rigs.length > 0, 'ships should have manufacturing rigs')
  assert.ok(
    rigs.every((id) => Number.isInteger(id)),
    'rig ids come back as numbers, not the string keys the modifier table is keyed by'
  )
})

test('a product nothing covers has no rigs', () => {
  assert.deepEqual(rigsForProduct(UNCOVERED_GROUP, UNCOVERED_CATEGORY), [])
})

test('rigsForProduct returns no duplicates even when group and category both match', () => {
  // A frigate matches on its group (Small T1 Ships) and its category (Ships),
  // so a rig covering both filters would otherwise appear twice.
  const rigs = rigsForProduct(FRIGATE_GROUP, SHIP_CATEGORY)
  assert.equal(new Set(rigs).size, rigs.length)
})

test('rigAppliesToProduct agrees with rigsForProduct', () => {
  const shipRigs = rigsForProduct(FRIGATE_GROUP, SHIP_CATEGORY)
  assert.ok(rigAppliesToProduct(shipRigs[0], FRIGATE_GROUP, SHIP_CATEGORY))
})

// The whole point: the bug this guards against is a rig for one product family
// silently discounting another. Charges and ships are covered by different
// filters, so a ship rig must not apply to a charge.
test('a rig for one product family does not apply to another', () => {
  const shipRigs = new Set(rigsForProduct(FRIGATE_GROUP, SHIP_CATEGORY))
  const chargeRigs = rigsForProduct(0, CHARGE_CATEGORY)
  assert.ok(chargeRigs.length > 0, 'charges should have their own rigs')
  const chargeOnly = chargeRigs.filter((id) => !shipRigs.has(id))
  assert.ok(chargeOnly.length > 0, 'the two families should not share every rig')
  chargeOnly.forEach((id) => {
    assert.equal(
      rigAppliesToProduct(id, FRIGATE_GROUP, SHIP_CATEGORY),
      false,
      `charge rig ${id} must not bonus a ship build`
    )
  })
})

test('drones resolve through their category, not a group listing', () => {
  assert.ok(rigsForProduct(0, DRONE_CATEGORY).length > 0)
})
