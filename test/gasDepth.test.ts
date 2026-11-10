// The gas_purchase_plan seam (src/app/api/mcp/gasDepth.ts): how one purchase
// splits between raw and compressed gas when it walks up both sell books.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  COMPRESSED_GAS_GROUP_ID,
  HARVESTABLE_CLOUD_GROUP_ID,
  matchGas,
  pairGases,
  planSplit,
  toLevels,
  type Book,
} from '../src/app/api/mcp/gasDepth.ts'

const book = (volumeM3: number, levels: Array<[number, number]>): Book => ({
  volumeM3,
  levels: levels.map(([price, units]) => ({ price, units })),
})

test('toLevels groups orders by price, cheapest first', () => {
  assert.deepEqual(
    toLevels([
      { price: 120, volume_remain: 5 },
      { price: 100, volume_remain: 3 },
      { price: 120, volume_remain: 2 },
    ]),
    [
      { price: 100, units: 3 },
      { price: 120, units: 7 },
    ]
  )
})

test('a small purchase takes only the cheaper form', () => {
  // Raw lands at 100 + 10 × 10 = 200. Compressed at (180 + 10 × 1) ÷ 0.95 = 200.0
  // is a hair more, so raw wins while its first order lasts.
  const split = planSplit(50, 10, book(10, [[100, 100]]), book(1, [[180.05, 1000]]))
  assert.equal(split.raw.units, 50)
  assert.equal(split.compressed.units, 0)
  assert.equal(split.legs.length, 1)
  assert.equal(split.short, 0)
  assert.equal(split.freightIsk, 50 * 10 * 10)
})

test('a large purchase switches to the other form where it becomes cheaper', () => {
  // Raw: 100 units at 100, then 1000 at 300 (landed 200, then 400).
  // Compressed: landed (190 + 10) ÷ 0.95 ≈ 210.5 for each usable unit.
  const split = planSplit(
    500,
    10,
    book(10, [
      [100, 100],
      [300, 1000],
    ]),
    book(1, [[190, 1000]])
  )
  assert.equal(split.raw.units, 100)
  // 400 usable from compressed: ⌈400 ÷ 0.95⌉ = 422 units.
  assert.equal(split.compressed.units, 422)
  assert.equal(split.usable, 500)
  assert.deepEqual(
    split.legs.map((l) => [l.form, l.units]),
    [
      ['raw', 100],
      ['compressed', 422],
    ]
  )
  assert.ok(Math.abs((split.marginalLanded ?? 0) - 200 / 0.95) < 1e-9)
})

test('the plan can change form more than once', () => {
  const split = planSplit(
    300,
    0,
    book(10, [
      [100, 100],
      [220, 100],
    ]),
    book(1, [
      [190, 100],
      [400, 1000],
    ])
  )
  // raw 100 at 100, compressed 100 at 200/usable, raw 100 at 220, then the
  // last few usable from compressed at 421.
  assert.deepEqual(
    split.legs.map((l) => l.form),
    ['raw', 'compressed', 'raw', 'compressed']
  )
  assert.equal(split.usable, 300)
})

test('freight pushes a bulky raw gas toward the compressed form', () => {
  const raw = book(10, [[100, 1000]])
  const compressed = book(1, [[110, 1000]])
  assert.equal(planSplit(10, 0, raw, compressed).raw.units, 10)
  assert.equal(planSplit(10, 700, raw, compressed).compressed.units, 11)
})

test('a book too thin for the quantity reports the shortfall', () => {
  const split = planSplit(100, 0, book(10, [[100, 30]]), book(1, []))
  assert.equal(split.usable, 30)
  assert.equal(split.short, 70)
})

test('two empty books plan nothing', () => {
  const split = planSplit(10, 0, book(10, []), book(1, []))
  assert.equal(split.usable, 0)
  assert.equal(split.marginalLanded, null)
  assert.equal(split.averageLanded, null)
})

const gases = pairGases([
  { typeID: 30375, name: 'Fullerite-C28', groupID: HARVESTABLE_CLOUD_GROUP_ID, volume: 2 },
  { typeID: 30370, name: 'Fullerite-C50', groupID: HARVESTABLE_CLOUD_GROUP_ID, volume: 1 },
  { typeID: 25268, name: 'Amber Cytoserocin', groupID: HARVESTABLE_CLOUD_GROUP_ID, volume: 10 },
  { typeID: 62402, name: 'Compressed Fullerite-C28', groupID: COMPRESSED_GAS_GROUP_ID, volume: 0.2 },
  { typeID: 62396, name: 'Compressed Amber Cytoserocin', groupID: COMPRESSED_GAS_GROUP_ID, volume: 1 },
])

test('pairGases finds the compressed form of each raw gas', () => {
  const c28 = gases.find((p) => p.raw.typeID === 30375)
  assert.equal(c28?.compressed?.typeID, 62402)
  assert.equal(gases.find((p) => p.raw.typeID === 30370)?.compressed, null)
  assert.equal(gases.length, 3)
})

test('matchGas takes the raw name, the compressed name or a unique part', () => {
  const name = (q: string) => {
    const m = matchGas(gases, q)
    return m.ok ? m.pair.raw.name : m.message
  }
  assert.equal(name('fullerite-c28'), 'Fullerite-C28')
  assert.equal(name('Compressed Amber Cytoserocin'), 'Amber Cytoserocin')
  assert.equal(name('C50'), 'Fullerite-C50')
  assert.match(name('Fullerite'), /matches 2 gases/)
  assert.match(name('Tritanium'), /not a Fullerite/)
})
