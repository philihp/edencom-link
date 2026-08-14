// Unit coverage for the restock field's pure seam
// (src/app/api/graphql/restock.ts). Two things matter here and neither is
// visible from the resolver: the ARITHMETIC (a sum spread over several stacks
// and both owner sides, and the two computed columns disagreeing in sign by
// design), and the REFUSALS — a target that resolved to the wrong denominator
// would produce a confidently wrong shopping number, so every ambiguous
// spelling has to fail loudly instead.
import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveTargets, restockLines, type NamedRef } from '../src/app/api/graphql/restock.ts'

// Stand-in for the ranked SDE search the resolver feeds in.
const CANDIDATES: Record<string, NamedRef[]> = {
  Tritanium: [{ id: '34', name: 'Tritanium' }],
  'Nitrogen Fuel Block': [{ id: '4051', name: 'Nitrogen Fuel Block' }],
  // A partial-match neighbour: the ranked search returns it, whole-name
  // matching must drop it.
  Nitrogen: [
    { id: '4051', name: 'Nitrogen Fuel Block' },
    { id: '17887', name: 'Oxygen Isotopes' },
  ],
  // Two DIFFERENT types genuinely sharing a name.
  Twins: [
    { id: '100', name: 'Twins' },
    { id: '200', name: 'Twins' },
  ],
  // The same type arriving twice from the search — one denominator, so fine.
  Echo: [
    { id: '300', name: 'Echo' },
    { id: '300', name: 'Echo' },
  ],
}

// The real search is case-insensitive, so the stub's own lookup has to be —
// otherwise it would fail a case the resolver handles.
const candidatesFor = (name: string): readonly NamedRef[] =>
  Object.entries(CANDIDATES).find(([term]) => term.toLowerCase() === name.toLowerCase())?.[1] ?? []

const resolved = (raw: Parameters<typeof resolveTargets>[0]) => {
  const result = resolveTargets(raw, candidatesFor)
  assert.ok(result.ok, `expected targets to resolve: ${result.ok ? '' : result.message}`)
  return result.targets
}

test('a whole name resolves to its type id, and a bare integer is already one', () => {
  assert.deepEqual(
    resolved([
      { type: 'Tritanium', quantity: 1000 },
      { type: '4051', quantity: 50 },
    ]),
    [
      { typeId: 34, quantity: 1000 },
      { typeId: 4051, quantity: 50 },
    ]
  )
})

test('name matching is case-insensitive but WHOLE — a partial hit is not a target', () => {
  assert.deepEqual(resolved([{ type: 'tritanium', quantity: 5 }]), [{ typeId: 34, quantity: 5 }])
  // "Nitrogen" ranks Nitrogen Fuel Block first, but names neither type whole.
  const partial = resolveTargets([{ type: 'Nitrogen', quantity: 5 }], candidatesFor)
  assert.equal(partial.ok, false)
  assert.match(partial.ok ? '' : partial.message, /No item type matched "Nitrogen"/)
})

test('the same type arriving twice from the search is one denominator, not an ambiguity', () => {
  assert.deepEqual(resolved([{ type: 'Echo', quantity: 7 }]), [{ typeId: 300, quantity: 7 }])
})

test('a name matching two different types is refused rather than summed over either', () => {
  const result = resolveTargets([{ type: 'Twins', quantity: 7 }], candidatesFor)
  assert.equal(result.ok, false)
  assert.match(result.ok ? '' : result.message, /matched 2 item types \(100, 200\)/)
})

test('an empty list, a blank type and a non-positive or fractional quantity are all refused', () => {
  for (const [raw, pattern] of [
    [[], /at least one target/],
    [[{ type: '   ', quantity: 5 }], /needs an item type/],
    [[{ type: 'Tritanium', quantity: 0 }], /whole number above zero/],
    [[{ type: 'Tritanium', quantity: -5 }], /whole number above zero/],
    [[{ type: 'Tritanium', quantity: 2.5 }], /whole number above zero/],
  ] as const) {
    const result = resolveTargets(raw, candidatesFor)
    assert.equal(result.ok, false, `expected a refusal for ${JSON.stringify(raw)}`)
    assert.match(result.ok ? '' : result.message, pattern)
  }
})

// Spelling one type two ways is the subtle one: both entries resolve, so only
// the post-resolution check catches that the two targets contradict each other.
test('naming one type twice is refused, even spelled once by name and once by id', () => {
  const result = resolveTargets(
    [
      { type: 'Tritanium', quantity: 1000 },
      { type: '34', quantity: 2000 },
    ],
    candidatesFor
  )
  assert.equal(result.ok, false)
  assert.match(result.ok ? '' : result.message, /type 34 appears more than once/)
})

const TARGETS = [
  { typeId: 34, quantity: 1000 },
  { typeId: 4051, quantity: 100 },
]

test('stacks of one type sum across rows, whichever owner side they came from', () => {
  const [line] = restockLines(
    [{ typeId: 34, quantity: 1000 }],
    [
      // two character stacks and a corp hangar stack, all the same type
      { type_id: 34, quantity: 200 },
      { type_id: 34, quantity: 300 },
      { type_id: '34', quantity: 100 },
    ],
    false
  )
  assert.equal(line.onHand, 600)
  assert.equal(line.toBuy, 400)
  assert.equal(line.delta, -400)
})

test('a stack with no quantity counts as one unit, like a ship or a fitted module', () => {
  const [line] = restockLines([{ typeId: 34, quantity: 10 }], [{ type_id: 34, quantity: null }], false)
  assert.equal(line.onHand, 1)
  assert.equal(line.toBuy, 9)
})

test('a type with no stacks at all reads as zero on hand, not as a missing line', () => {
  const [line] = restockLines([{ typeId: 34, quantity: 1000 }], [], false)
  assert.deepEqual(line, { typeId: 34, target: 1000, onHand: 0, delta: -1000, toBuy: 1000 })
})

// The two columns exist precisely because they disagree above target: delta
// keeps the surplus, toBuy clamps it away.
test('delta stays signed while toBuy clamps at zero', () => {
  const [over] = restockLines([{ typeId: 34, quantity: 100 }], [{ type_id: 34, quantity: 250 }], false)
  assert.equal(over.delta, 150)
  assert.equal(over.toBuy, 0)

  const [exact] = restockLines([{ typeId: 34, quantity: 100 }], [{ type_id: 34, quantity: 100 }], false)
  assert.equal(exact.delta, 0)
  assert.equal(exact.toBuy, 0)
})

test('onlyBelowTarget drops the covered lines, and false keeps every target', () => {
  const stacks = [
    { type_id: 34, quantity: 5000 },
    { type_id: 4051, quantity: 40 },
  ]
  assert.deepEqual(
    restockLines(TARGETS, stacks, true).map((l) => l.typeId),
    [4051]
  )
  assert.deepEqual(
    restockLines(TARGETS, stacks, false).map((l) => l.typeId),
    [34, 4051]
  )
})

test('lines come back in the order the targets were given', () => {
  const reversed = [...TARGETS].reverse()
  assert.deepEqual(
    restockLines(reversed, [], false).map((l) => l.typeId),
    [4051, 34]
  )
})

test('a stack of an untargeted type never leaks into a line', () => {
  const lines = restockLines(
    [{ typeId: 34, quantity: 10 }],
    [
      { type_id: 34, quantity: 4 },
      { type_id: 9999, quantity: 100000 },
    ],
    false
  )
  assert.equal(lines.length, 1)
  assert.equal(lines[0].onHand, 4)
})
