import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  isOriginal,
  isSortKey,
  rowQuantity,
  sortBpos,
  stackBpos,
  totalBpos,
  type BlueprintRow,
  type BpoEntry,
} from '../src/app/bpos/stack.ts'

const row = (over: Partial<BlueprintRow> = {}): BlueprintRow => ({
  type_id: 681,
  material_efficiency: 0,
  time_efficiency: 0,
  quantity: -1,
  runs: -1,
  ...over,
})

describe('isOriginal', () => {
  it('reads runs = -1 as an original', () => {
    assert.equal(isOriginal(row()), true)
  })

  it('rejects a copy however many runs it has left', () => {
    assert.equal(isOriginal(row({ runs: 10, quantity: -2 })), false)
    assert.equal(isOriginal(row({ runs: 1, quantity: -2 })), false)
  })
})

describe('rowQuantity', () => {
  it('counts a positive quantity as an unresearched stack', () => {
    assert.equal(rowQuantity(row({ quantity: 8 })), 8)
  })

  it('counts a singleton (-1) as one', () => {
    assert.equal(rowQuantity(row({ quantity: -1 })), 1)
  })

  it('tolerates PostgREST handing bigints back as strings', () => {
    assert.equal(rowQuantity(row({ quantity: '3' })), 3)
  })
})

describe('stackBpos', () => {
  it('collapses identical (type, ME, TE) rows and sums their quantities', () => {
    const stacks = stackBpos([row(), row(), row({ quantity: 5 })])
    assert.equal(stacks.length, 1)
    assert.equal(stacks[0].quantity, 7)
  })

  it('keeps differently researched copies of one blueprint apart', () => {
    const stacks = stackBpos([row(), row({ material_efficiency: 10, time_efficiency: 20 })])
    assert.equal(stacks.length, 2)
    assert.deepEqual(
      stacks.map((s) => [s.materialEfficiency, s.timeEfficiency, s.quantity]),
      [
        [0, 0, 1],
        [10, 20, 1],
      ]
    )
  })

  it('drops copies even when the caller forgot to filter them in SQL', () => {
    assert.deepEqual(stackBpos([row({ runs: 300, quantity: -2 })]), [])
  })

  it('is empty for no rows', () => {
    assert.deepEqual(stackBpos([]), [])
  })
})

describe('sortBpos', () => {
  const entry = (over: Partial<BpoEntry>): BpoEntry => ({
    typeId: 1,
    materialEfficiency: 0,
    timeEfficiency: 0,
    quantity: 1,
    name: 'Thing Blueprint',
    category: 'Module',
    ...over,
  })

  it('sorts by name, case-insensitively', () => {
    const sorted = sortBpos([entry({ name: 'zeta' }), entry({ name: 'Alpha' })], 'name')
    assert.deepEqual(
      sorted.map((e) => e.name),
      ['Alpha', 'zeta']
    )
  })

  it('puts the best-researched copy of a name first', () => {
    const sorted = sortBpos(
      [entry({ materialEfficiency: 0 }), entry({ materialEfficiency: 10 }), entry({ materialEfficiency: 5 })],
      'name'
    )
    assert.deepEqual(
      sorted.map((e) => e.materialEfficiency),
      [10, 5, 0]
    )
  })

  it('sorts by category, then by name within it', () => {
    const sorted = sortBpos(
      [
        entry({ category: 'Ship', name: 'Rifter Blueprint' }),
        entry({ category: 'Module', name: 'Zebra Blueprint' }),
        entry({ category: 'Module', name: 'Aardvark Blueprint' }),
      ],
      'category'
    )
    assert.deepEqual(
      sorted.map((e) => e.name),
      ['Aardvark Blueprint', 'Zebra Blueprint', 'Rifter Blueprint']
    )
  })

  it('sinks unresolved categories to the bottom rather than the top', () => {
    const sorted = sortBpos(
      [entry({ category: null, name: 'Aaa' }), entry({ category: 'Ship', name: 'Zzz' })],
      'category'
    )
    assert.deepEqual(
      sorted.map((e) => e.category),
      ['Ship', null]
    )
  })

  it('does not mutate its input', () => {
    const entries = [entry({ name: 'zeta' }), entry({ name: 'Alpha' })]
    sortBpos(entries, 'name')
    assert.equal(entries[0].name, 'zeta')
  })
})

describe('totalBpos', () => {
  it('counts blueprints, not lines', () => {
    assert.equal(totalBpos([{ quantity: 8 }, { quantity: 1 }]), 9)
  })
})

describe('isSortKey', () => {
  it('accepts the two the table offers and nothing else', () => {
    assert.equal(isSortKey('name'), true)
    assert.equal(isSortKey('category'), true)
    assert.equal(isSortKey('quantity'), false)
    assert.equal(isSortKey(null), false)
  })
})
