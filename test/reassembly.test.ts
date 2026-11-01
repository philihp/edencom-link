// The reassembly fold (src/jobs/reassembly.js, docs/ship-memory.md
// "Reassembly"): which vanished hulls became packs, and which debut hulls
// inherit which memory, by the three rules in order. Pinned hard, because the
// rules are the whole mechanism: a wrong carry gives a hull another ship's
// past.
import assert from 'node:assert/strict'
import test from 'node:test'

import { carriesOf, packsOf, reassemblyEvents } from '../src/jobs/reassembly.js'

const RIFTER = 587
const WREATHE = 653
const RENS = 60004588
const HEK = 60005686
const NOW = '2026-11-01T12:00:00.000Z'

const ALICE = { kind: 'character', id: 'reg-a' }
const BOB = { kind: 'character', id: 'reg-b' }
const CORP = { kind: 'corporation', id: '98000001' }

type Row = {
  itemId: number
  typeId: number
  locationId: number | null
  quantity: number
  isSingleton: boolean
  previousQuantity?: number
}

const hull = (itemId: number, over: Partial<Row> = {}): Row => ({
  itemId,
  typeId: RIFTER,
  locationId: RENS,
  quantity: 1,
  isSingleton: true,
  ...over,
})
const stack = (itemId: number, quantity: number, over: Partial<Row> = {}): Row => ({
  itemId,
  typeId: RIFTER,
  locationId: RENS,
  quantity,
  isSingleton: false,
  ...over,
})

type Pack = {
  id: number
  itemId: number
  typeId: number
  owner: { kind: string; id: string }
  stackItemId: number | null
  locationId: number | null
}
const pack = (id: number, itemId: number, over: Partial<Pack> = {}): Pack => ({
  id,
  itemId,
  typeId: RIFTER,
  owner: ALICE,
  stackItemId: null,
  locationId: RENS,
  ...over,
})

const run = (over: Partial<Parameters<typeof reassemblyEvents>[0]> = {}) => ({
  owner: ALICE,
  vanished: [] as Row[],
  debuts: [] as Row[],
  changed: [] as Row[],
  memories: new Map<number, number>(),
  pendingPacks: [] as Pack[],
  now: NOW,
  ...over,
})

// ── packs ─────────────────────────────────────────────────────────────────

test('a memory-bearing hull vanishing as a stack of its type appears at its place is a pack naming that stack', () => {
  const events = packsOf(
    run({
      vanished: [hull(1001)],
      debuts: [stack(2001, 1)],
      memories: new Map([[1001, RIFTER]]),
    })
  )
  assert.deepEqual(events, [{ itemId: 1001, typeId: RIFTER, stackItemId: 2001, locationId: RENS, packedAt: NOW }])
})

test('a stack that grew takes the hull too', () => {
  const events = packsOf(
    run({
      vanished: [hull(1001)],
      changed: [stack(2001, 4, { previousQuantity: 3 })],
      memories: new Map([[1001, RIFTER]]),
    })
  )
  assert.equal(events[0]?.stackItemId, 2001)
})

test('a hull that vanished with no stack taking it was destroyed or traded away: not a pack', () => {
  assert.deepEqual(packsOf(run({ vanished: [hull(1001)], memories: new Map([[1001, RIFTER]]) })), [])
})

test('a stack that shrank, moved or sits elsewhere did not take the hull', () => {
  const events = packsOf(
    run({
      vanished: [hull(1001)],
      changed: [stack(2001, 2, { previousQuantity: 3 }), stack(2003, 2, { previousQuantity: 2 })],
      debuts: [stack(2002, 1, { locationId: HEK }), stack(2004, 1, { typeId: WREATHE })],
      memories: new Map([[1001, RIFTER]]),
    })
  )
  assert.deepEqual(events, [])
})

test('a vanished hull with no memory is nothing to remember', () => {
  assert.deepEqual(packsOf(run({ vanished: [hull(1001)], debuts: [stack(2001, 1)] })), [])
})

test('a packaged row that kept its id through the repackage is still the hull: merging it into a stack is a pack', () => {
  const events = packsOf(
    run({
      vanished: [stack(1001, 1)],
      changed: [stack(2001, 2, { previousQuantity: 1 })],
      memories: new Map([[1001, RIFTER]]),
    })
  )
  assert.deepEqual(events, [{ itemId: 1001, typeId: RIFTER, stackItemId: 2001, locationId: RENS, packedAt: NOW }])
})

test('two stacks growing at once leave the pack with a place and no stack', () => {
  const events = packsOf(
    run({
      vanished: [hull(1001)],
      debuts: [stack(2001, 1)],
      changed: [stack(2002, 2, { previousQuantity: 1 })],
      memories: new Map([[1001, RIFTER]]),
    })
  )
  assert.deepEqual(events, [{ itemId: 1001, typeId: RIFTER, stackItemId: null, locationId: RENS, packedAt: NOW }])
})

test('two memory hulls into one stack are two packs on that stack', () => {
  const events = packsOf(
    run({
      vanished: [hull(1001), hull(1002)],
      changed: [stack(2001, 5, { previousQuantity: 3 })],
      memories: new Map([
        [1001, RIFTER],
        [1002, RIFTER],
      ]),
    })
  )
  assert.deepEqual(
    events.map((p) => [p.itemId, p.stackItemId]),
    [
      [1001, 2001],
      [1002, 2001],
    ]
  )
})

// ── rule 1: within one interval ───────────────────────────────────────────

test('rule 1: a memory hull gone and a hull of its type debuting at the same place, no stack moving, is one carry', () => {
  const { carries, ambiguous } = carriesOf(
    run({ vanished: [hull(1001)], debuts: [hull(1003)], memories: new Map([[1001, RIFTER]]) })
  )
  assert.deepEqual(carries, [{ fromItemId: 1001, toItemId: 1003, packId: null, rule: 'interval' }])
  assert.deepEqual(ambiguous, [])
})

test('rule 1 needs the same place and type', () => {
  const { carries } = carriesOf(
    run({
      vanished: [hull(1001)],
      debuts: [hull(1003, { locationId: HEK }), hull(1004, { typeId: WREATHE })],
      memories: new Map([[1001, RIFTER]]),
    })
  )
  assert.deepEqual(carries, [])
})

test('rule 1 is off when any stack of the type at the place changed: that hull went into the stack', () => {
  const input = run({
    vanished: [hull(1001)],
    debuts: [hull(1003)],
    changed: [stack(2001, 2, { previousQuantity: 1 })],
    memories: new Map([[1001, RIFTER]]),
  })
  const { carries, ambiguous } = carriesOf(input)
  assert.deepEqual(carries, [])
  assert.deepEqual(ambiguous, [])
  // and the whole run shows it as a pack instead.
  assert.equal(reassemblyEvents(input).packs.length, 1)
})

test('rule 1: two memory hulls gone and one debut is ambiguous, nothing carried', () => {
  const { carries, ambiguous } = carriesOf(
    run({
      vanished: [hull(1001), hull(1002)],
      debuts: [hull(1003)],
      memories: new Map([
        [1001, RIFTER],
        [1002, RIFTER],
      ]),
    })
  )
  assert.deepEqual(carries, [])
  assert.deepEqual(ambiguous, [{ toItemId: 1003, rule: 'interval', candidates: [1001, 1002] }])
})

test('two debuts both pointing at one memory are both left for the owner', () => {
  const { carries, ambiguous } = carriesOf(
    run({ vanished: [hull(1001)], debuts: [hull(1003), hull(1004)], memories: new Map([[1001, RIFTER]]) })
  )
  assert.deepEqual(carries, [])
  assert.deepEqual(
    ambiguous.map((a) => a.toItemId),
    [1003, 1004]
  )
})

// ── rule 2: the stack it went into ────────────────────────────────────────

test('rule 2: a pending pack whose stack shrank this run is the debut hull, under any owner', () => {
  const { carries } = carriesOf(
    run({
      owner: BOB,
      debuts: [hull(1003, { locationId: HEK })],
      changed: [stack(2001, 2, { previousQuantity: 3, locationId: HEK })],
      pendingPacks: [pack(11, 1001, { stackItemId: 2001, owner: ALICE })],
    })
  )
  assert.deepEqual(carries, [{ fromItemId: 1001, toItemId: 1003, packId: 11, rule: 'stack' }])
})

test('rule 2: a stack vanishing (its last unit assembled) counts as shrinking', () => {
  const { carries } = carriesOf(
    run({
      debuts: [hull(1003)],
      vanished: [stack(2001, 1)],
      pendingPacks: [pack(11, 1001, { stackItemId: 2001 })],
    })
  )
  assert.equal(carries[0]?.packId, 11)
})

test('rule 2 ignores a pack with no stack, and a stack that did not shrink', () => {
  const { carries, ambiguous } = carriesOf(
    run({
      owner: BOB,
      debuts: [hull(1003, { locationId: HEK })],
      changed: [stack(2001, 3, { previousQuantity: 3, locationId: HEK })],
      pendingPacks: [pack(11, 1001, { stackItemId: 2001 }), pack(12, 1002, { stackItemId: null })],
    })
  )
  assert.deepEqual(carries, [])
  assert.deepEqual(ambiguous, [])
})

test('rule 2: two packs on one stack are ambiguous', () => {
  const { carries, ambiguous } = carriesOf(
    run({
      debuts: [hull(1003)],
      changed: [stack(2001, 1, { previousQuantity: 2 })],
      pendingPacks: [pack(11, 1001, { stackItemId: 2001 }), pack(12, 1002, { stackItemId: 2001 })],
    })
  )
  assert.deepEqual(carries, [])
  assert.deepEqual(ambiguous, [{ toItemId: 1003, rule: 'stack', candidates: [1001, 1002] }])
})

// ── rule 3: same owner and place ──────────────────────────────────────────

test('rule 3: a pending pack of the type under this owner at this place', () => {
  const { carries } = carriesOf(run({ debuts: [hull(1003)], pendingPacks: [pack(11, 1001)] }))
  assert.deepEqual(carries, [{ fromItemId: 1001, toItemId: 1003, packId: 11, rule: 'place' }])
})

test('rule 3 needs this owner, this place and this type', () => {
  const { carries } = carriesOf(
    run({
      debuts: [hull(1003)],
      pendingPacks: [
        pack(11, 1001, { owner: BOB }),
        pack(12, 1002, { locationId: HEK }),
        pack(13, 1004, { typeId: WREATHE }),
      ],
    })
  )
  assert.deepEqual(carries, [])
})

test('rule 3 matches a corporation owner by kind and id', () => {
  const { carries } = carriesOf(
    run({ owner: CORP, debuts: [hull(1003)], pendingPacks: [pack(11, 1001, { owner: { ...CORP } })] })
  )
  assert.equal(carries.length, 1)
  assert.equal(
    carriesOf(
      run({
        owner: { kind: 'character', id: CORP.id },
        debuts: [hull(1003)],
        pendingPacks: [pack(11, 1001, { owner: CORP })],
      })
    ).carries.length,
    0
  )
})

// ── the order of the rules ────────────────────────────────────────────────

test('the first rule with any candidate decides: an ambiguous rule 1 does not fall through to a clean rule 3', () => {
  const { carries, ambiguous } = carriesOf(
    run({
      vanished: [hull(1001), hull(1002)],
      debuts: [hull(1003)],
      memories: new Map([
        [1001, RIFTER],
        [1002, RIFTER],
      ]),
      pendingPacks: [pack(11, 1005)],
    })
  )
  assert.deepEqual(carries, [])
  assert.equal(ambiguous[0]?.rule, 'interval')
})

test('rule 2 beats rule 3 when both hold', () => {
  const { carries } = carriesOf(
    run({
      debuts: [hull(1003)],
      changed: [stack(2001, 1, { previousQuantity: 2 })],
      pendingPacks: [pack(11, 1001, { stackItemId: 2001, owner: BOB, locationId: HEK }), pack(12, 1002)],
    })
  )
  assert.deepEqual(carries, [{ fromItemId: 1001, toItemId: 1003, packId: 11, rule: 'stack' }])
})

// ── what is never a candidate ─────────────────────────────────────────────

test('a debut stack, a debut of another type, or a debut with no candidate at all carries nothing', () => {
  const { carries, ambiguous } = carriesOf(
    run({
      debuts: [stack(2001, 1), hull(1003, { typeId: WREATHE }), hull(1004, { typeId: 11176 })],
      pendingPacks: [pack(11, 1001)],
    })
  )
  assert.deepEqual(carries, [])
  assert.deepEqual(ambiguous, [])
})

test('ids arrive as strings from PostgREST and as numbers from ESI; both key the same hull', () => {
  const { carries } = carriesOf(
    run({
      debuts: [{ ...hull(1003), itemId: '1003' as unknown as number, typeId: String(RIFTER) as unknown as number }],
      pendingPacks: [pack(11, 1001, { locationId: String(RENS) as unknown as number })],
    })
  )
  assert.deepEqual(carries, [{ fromItemId: 1001, toItemId: 1003, packId: 11, rule: 'place' }])
})

test('an empty run has no events', () => {
  assert.deepEqual(reassemblyEvents(run()), { packs: [], carries: [], ambiguous: [] })
})
