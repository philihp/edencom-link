// Unit coverage for the seam both appraisal callers share (the asset viewer's
// POST /api/appraisal and the MCP appraise_assets tool): turning a walked
// subtree's type→quantity tally into the lines sent upstream.
//
// What's worth pinning here is everything that would be quietly wrong rather
// than loudly broken — a blueprint folded into the total, a hangar counted twice
// because two type ids share a name, or a nameless type disappearing instead of
// being reported. The walk that feeds it is SQL and RLS (collectAssetLines.ts).
import assert from 'node:assert/strict'
import test from 'node:test'

import { toAppraisalLines, type TypeInfo } from '../src/app/api/appraisal/assetLines.ts'

const TRITANIUM = 34
const RIFTER = 587
// EVE's SDE Blueprint category (BPOs/BPCs and reaction formulas alike).
const BLUEPRINT_CATEGORY = 9

const TYPES: Record<number, TypeInfo> = {
  [TRITANIUM]: { name: 'Tritanium', categoryID: 4 },
  [RIFTER]: { name: 'Rifter', categoryID: 6 },
  690: { name: 'Rifter Blueprint', categoryID: BLUEPRINT_CATEGORY },
}

test('prices what it can, in one line per name', () => {
  const { lines, skippedBlueprints, unnamed } = toAppraisalLines(
    new Map([
      [TRITANIUM, 1_000_000],
      [RIFTER, 3],
    ]),
    TYPES
  )
  assert.deepEqual(lines, [
    { name: 'Tritanium', quantity: 1_000_000 },
    { name: 'Rifter', quantity: 3 },
  ])
  assert.equal(skippedBlueprints, 0)
  assert.deepEqual(unnamed, [])
})

test('skips blueprints and says how many', () => {
  // An asset row carries no way to tell an original from a worthless copy, so a
  // priced blueprint would be wrong more often than right.
  const { lines, skippedBlueprints } = toAppraisalLines(
    new Map([
      [RIFTER, 1],
      [690, 4],
    ]),
    TYPES
  )
  assert.deepEqual(lines, [{ name: 'Rifter', quantity: 1 }])
  assert.equal(skippedBlueprints, 1)
})

test('merges distinct type ids that share one name', () => {
  // Rare but real in the SDE; two lines would be counted twice by the provider.
  const types: Record<number, TypeInfo> = {
    1: { name: 'Nanite Repair Paste', categoryID: 4 },
    2: { name: 'Nanite Repair Paste', categoryID: 4 },
  }
  const { lines } = toAppraisalLines(
    new Map([
      [1, 10],
      [2, 5],
    ]),
    types
  )
  assert.deepEqual(lines, [{ name: 'Nanite Repair Paste', quantity: 15 }])
})

test('reports unnameable types by id instead of dropping them', () => {
  // The API is keyed on item name, so a type the SDE can't name can't be priced
  // — but it was in the hangar, and the total quietly omits it.
  const { lines, unnamed } = toAppraisalLines(
    new Map([
      [RIFTER, 1],
      [999999, 2],
    ]),
    TYPES
  )
  assert.deepEqual(lines, [{ name: 'Rifter', quantity: 1 }])
  assert.deepEqual(unnamed, ['#999999'])
})

test('an empty subtree yields no lines rather than an empty request', () => {
  const { lines, skippedBlueprints, unnamed } = toAppraisalLines(new Map(), TYPES)
  assert.deepEqual(lines, [])
  assert.equal(skippedBlueprints, 0)
  assert.deepEqual(unnamed, [])
})
