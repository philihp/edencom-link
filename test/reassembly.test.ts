// The reassembly fold (src/jobs/reassembly.js, docs/ship-memory.md
// "Reassembly"): which vanished hulls became packs, and which assembled hulls
// — a stack's id flipping to a singleton, or a singleton debut — inherit
// which memory, by the three rules in order. Pinned hard, because the
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
  previousSingleton?: boolean | null
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
// The assembly as production shows it: the packaged row's own id, a stack of
// `from` units a run ago, is a hull of one now.
const flip = (itemId: number, from = 1, over: Partial<Row> = {}): Row => ({
  ...hull(itemId, over),
  previousQuantity: from,
  previousSingleton: false,
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

// ── rule 1: within one interval (a debut) ─────────────────────────────────

test('rule 1: a memory hull gone and a hull of its type debuting at the same place, no stack moving, is one carry', () => {
  const { carries, ambiguous } = carriesOf(
    run({ vanished: [hull(1001)], debuts: [hull(1003)], memories: new Map([[1001, RIFTER]]) })
  )
  assert.deepEqual(carries, [{ fromItemId: 1001, toItemId: 1003, packId: null, rule: 'interval', via: 'debut' }])
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

test('rule 1 is off when a stack of the type at the place flipped into a hull this run: a flip is a stack changing', () => {
  // Alice's remembered Rifter 1001 left (traded away assembled) in the same
  // run her stack 2001 was assembled into a hull and a contract hull 1003
  // arrived. Neither new hull is 1001.
  const { carries, ambiguous } = carriesOf(
    run({
      vanished: [hull(1001)],
      debuts: [hull(1003)],
      changed: [flip(2001)],
      memories: new Map([[1001, RIFTER]]),
    })
  )
  assert.deepEqual(carries, [])
  assert.deepEqual(ambiguous, [])
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
  assert.deepEqual(ambiguous, [{ toItemId: 1003, rule: 'interval', candidates: [1001, 1002], via: 'debut' }])
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

test('rule 1 never applies to a flip: the flipped id was a stack, so a stack of the type changed', () => {
  const { carries, ambiguous } = carriesOf(
    run({ vanished: [hull(1001)], changed: [flip(2001)], memories: new Map([[1001, RIFTER]]) })
  )
  assert.deepEqual(carries, [])
  assert.deepEqual(ambiguous, [])
})

// ── rule 2: the stack it went into ────────────────────────────────────────

test("rule 2: the pack's stack flipping into a hull is that hull, with certainty, under any owner", () => {
  // Alice packed 1001 into stack 2001 and contracted the stack to Bob, who
  // assembled it: 2001 is Bob's hull now, and the memory goes with it.
  const { carries, ambiguous } = carriesOf(
    run({
      owner: BOB,
      changed: [flip(2001, 1, { locationId: HEK })],
      pendingPacks: [pack(11, 1001, { stackItemId: 2001, owner: ALICE })],
    })
  )
  assert.deepEqual(carries, [{ fromItemId: 1001, toItemId: 2001, packId: 11, rule: 'stack', via: 'flip' }])
  assert.deepEqual(ambiguous, [])
})

test("rule 2: a hull assembled out of a larger stack takes the stack's id, and the memory packed into it", () => {
  // The measured shape: a stack of 31 is a hull of one now; the other 30 went
  // on under a new id, which debuts as a stack and is nothing to carry into.
  const { carries, ambiguous } = carriesOf(
    run({
      changed: [flip(2001, 31)],
      debuts: [stack(2002, 30)],
      pendingPacks: [pack(11, 1001, { stackItemId: 2001 })],
    })
  )
  assert.deepEqual(carries, [{ fromItemId: 1001, toItemId: 2001, packId: 11, rule: 'stack', via: 'flip' }])
  assert.deepEqual(ambiguous, [])
})

test('rule 2: a pending pack whose stack shrank while a hull debuted is still that hull (the remainder keeping the id)', () => {
  const { carries } = carriesOf(
    run({
      owner: BOB,
      debuts: [hull(1003, { locationId: HEK })],
      changed: [stack(2001, 2, { previousQuantity: 3, locationId: HEK })],
      pendingPacks: [pack(11, 1001, { stackItemId: 2001, owner: ALICE })],
    })
  )
  assert.deepEqual(carries, [{ fromItemId: 1001, toItemId: 1003, packId: 11, rule: 'stack', via: 'debut' }])
})

test('rule 2: a stack vanishing while a hull debuted counts as shrinking', () => {
  const { carries } = carriesOf(
    run({
      debuts: [hull(1003)],
      vanished: [stack(2001, 1)],
      pendingPacks: [pack(11, 1001, { stackItemId: 2001 })],
    })
  )
  assert.equal(carries[0]?.packId, 11)
})

test('rule 2 ignores a pack on another stack, and a stack that did not shrink', () => {
  const { carries, ambiguous } = carriesOf(
    run({
      owner: BOB,
      changed: [flip(2003, 1, { locationId: HEK }), stack(2001, 3, { previousQuantity: 3, locationId: HEK })],
      pendingPacks: [pack(11, 1001, { stackItemId: 2001 })],
    })
  )
  assert.deepEqual(carries, [])
  assert.deepEqual(ambiguous, [])
})

test('rule 2: two packs in one stack are ambiguous when it flips, and both are listed', () => {
  const { carries, ambiguous } = carriesOf(
    run({
      changed: [flip(2001, 2)],
      pendingPacks: [pack(11, 1001, { stackItemId: 2001 }), pack(12, 1002, { stackItemId: 2001 })],
    })
  )
  assert.deepEqual(carries, [])
  assert.deepEqual(ambiguous, [{ toItemId: 2001, rule: 'stack', candidates: [1001, 1002], via: 'flip' }])
})

test('two flips in one run cannot both be one pack: contested, both left for the owner', () => {
  const { carries, ambiguous } = carriesOf(
    run({
      changed: [flip(2001), flip(2003)],
      pendingPacks: [pack(11, 1001, { stackItemId: 2001 }), pack(12, 1002, { stackItemId: 2003 })],
    })
  )
  // Two packs, two flips, each naming its own stack: both carry.
  assert.deepEqual(
    carries.map((c) => [c.fromItemId, c.toItemId]),
    [
      [1001, 2001],
      [1002, 2003],
    ]
  )
  assert.deepEqual(ambiguous, [])
})

// ── rule 3: same owner and place (a flip) ─────────────────────────────────

test('rule 3: a pack that could name no stack is carried into the flip of a stack under this owner at this place', () => {
  // Two stacks grew at Rens when 1001 was packed, so the pack names the
  // place and no stack. One of them is a hull now.
  const { carries } = carriesOf(run({ changed: [flip(2001)], pendingPacks: [pack(11, 1001)] }))
  assert.deepEqual(carries, [{ fromItemId: 1001, toItemId: 2001, packId: 11, rule: 'place', via: 'flip' }])
})

test('rule 3 needs this owner, this place and this type', () => {
  const { carries } = carriesOf(
    run({
      changed: [flip(2001)],
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
    run({ owner: CORP, changed: [flip(2001)], pendingPacks: [pack(11, 1001, { owner: { ...CORP } })] })
  )
  assert.equal(carries.length, 1)
  assert.equal(
    carriesOf(
      run({
        owner: { kind: 'character', id: CORP.id },
        changed: [flip(2001)],
        pendingPacks: [pack(11, 1001, { owner: CORP })],
      })
    ).carries.length,
    0
  )
})

test('rule 3 never applies to a debut: a hull bought on contract beside a pending pack is not that pack', () => {
  // Before the measurement this carried, giving a new hull another ship's
  // past; a hull assembled from Alice's stack would have flipped, not debuted.
  const { carries, ambiguous } = carriesOf(run({ debuts: [hull(1003)], pendingPacks: [pack(11, 1001)] }))
  assert.deepEqual(carries, [])
  assert.deepEqual(ambiguous, [])
})

// ── the order of the rules ────────────────────────────────────────────────

test('the first rule with any candidate decides: an ambiguous rule 1 does not fall through to a clean rule 2', () => {
  const { carries, ambiguous } = carriesOf(
    run({
      vanished: [hull(1001), hull(1002), stack(2005, 1, { locationId: HEK })],
      debuts: [hull(1003)],
      memories: new Map([
        [1001, RIFTER],
        [1002, RIFTER],
      ]),
      pendingPacks: [pack(11, 1005, { stackItemId: 2005, locationId: HEK })],
    })
  )
  assert.deepEqual(carries, [])
  assert.equal(ambiguous[0]?.rule, 'interval')
})

test('rule 2 beats rule 3 when both hold', () => {
  const { carries } = carriesOf(
    run({
      changed: [flip(2001)],
      pendingPacks: [pack(11, 1001, { stackItemId: 2001, owner: BOB, locationId: HEK }), pack(12, 1002)],
    })
  )
  assert.deepEqual(carries, [{ fromItemId: 1001, toItemId: 2001, packId: 11, rule: 'stack', via: 'flip' }])
})

// ── what is never a candidate ─────────────────────────────────────────────

test('a debut stack, a hull of another type, a changed row that did not flip, or a hull with no candidate at all carries nothing', () => {
  const { carries, ambiguous } = carriesOf(
    run({
      debuts: [stack(2001, 1), hull(1003, { typeId: WREATHE }), hull(1004, { typeId: 11176 })],
      changed: [
        hull(1005, { previousQuantity: 1, previousSingleton: true }), // a hull renamed or moved
        stack(2002, 1, { previousQuantity: 2, previousSingleton: false }), // a stack that shrank
        flip(2003, 1, { typeId: WREATHE }), // a flip of another type
      ],
      pendingPacks: [pack(11, 1001)],
    })
  )
  assert.deepEqual(carries, [])
  assert.deepEqual(ambiguous, [])
})

test('a changed row with no previousSingleton (an older reconcile) is not read as a flip', () => {
  const { carries } = carriesOf(
    run({ changed: [hull(2001, { previousQuantity: 1 })], pendingPacks: [pack(11, 1001, { stackItemId: 2001 })] })
  )
  assert.deepEqual(carries, [])
})

test('ids arrive as strings from PostgREST and as numbers from ESI; both key the same hull', () => {
  const { carries } = carriesOf(
    run({
      changed: [{ ...flip(2001), itemId: '2001' as unknown as number, typeId: String(RIFTER) as unknown as number }],
      pendingPacks: [pack(11, 1001, { stackItemId: '2001' as unknown as number })],
    })
  )
  assert.deepEqual(carries, [{ fromItemId: 1001, toItemId: 2001, packId: 11, rule: 'stack', via: 'flip' }])
})

test('an empty run has no events', () => {
  assert.deepEqual(reassemblyEvents(run()), { packs: [], carries: [], ambiguous: [] })
})
