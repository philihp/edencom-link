import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { blueprintMatches, foldHits, MIN_QUERY_LENGTH, type TypeMatch } from '../src/app/blueprint/searchHits.ts'
import type { BlueprintRow } from '../src/app/bpos/stack.ts'

const match = (over: Partial<TypeMatch> = {}): TypeMatch => ({
  typeID: 681,
  name: 'Rifter Blueprint',
  categoryID: 9,
  ...over,
})

const row = (over: Partial<BlueprintRow> = {}): BlueprintRow => ({
  type_id: 681,
  material_efficiency: 0,
  time_efficiency: 0,
  quantity: -1,
  runs: -1,
  ...over,
})

describe('blueprintMatches', () => {
  it('keeps only the blueprint category', () => {
    const names = blueprintMatches([match(), match({ typeID: 587, name: 'Rifter', categoryID: 6 })])
    assert.deepEqual([...names], [[681, 'Rifter Blueprint']])
  })

  it('drops a type the mirror gives no category', () => {
    assert.equal(blueprintMatches([match({ categoryID: null })]).size, 0)
  })

  it('is empty for no results', () => {
    assert.equal(blueprintMatches([]).size, 0)
  })
})

describe('foldHits', () => {
  const names = new Map([
    [681, 'Rifter Blueprint'],
    [645, 'Dominix Blueprint'],
  ])

  it('collapses the same blueprint across research levels into one line', () => {
    const hits = foldHits([row(), row({ material_efficiency: 10, time_efficiency: 20 }), row({ quantity: 6 })], names)
    assert.deepEqual(hits, [{ typeId: 681, name: 'Rifter Blueprint', quantity: 8 }])
  })

  it('counts an unresearched stack by its quantity and a singleton as one', () => {
    assert.equal(foldHits([row({ quantity: 8 })], names)[0].quantity, 8)
    assert.equal(foldHits([row({ quantity: -1 })], names)[0].quantity, 1)
  })

  it('drops copies even when SQL forgot to', () => {
    assert.deepEqual(foldHits([row({ runs: 10, quantity: -2 })], names), [])
  })

  it('drops a row the search never asked about', () => {
    assert.deepEqual(foldHits([row({ type_id: 999 })], names), [])
  })

  it('orders by name, case-insensitively', () => {
    const hits = foldHits([row(), row({ type_id: 645 })], names)
    assert.deepEqual(
      hits.map((h) => h.name),
      ['Dominix Blueprint', 'Rifter Blueprint']
    )
  })

  it('normalizes ids arriving from PostgREST as strings', () => {
    assert.deepEqual(foldHits([row({ type_id: '681', quantity: '3', runs: '-1' })], names), [
      { typeId: 681, name: 'Rifter Blueprint', quantity: 3 },
    ])
  })
})

describe('MIN_QUERY_LENGTH', () => {
  it('is short enough for a real term but long enough to narrow', () => {
    assert.equal(MIN_QUERY_LENGTH, 3)
  })
})
