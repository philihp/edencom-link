import { filter, groupBy, map, reduce, uniq } from 'ramda'

// Reassembly: a repackaged hull's memory goes back into the hull assembled
// from it (docs/ship-memory.md, "Reassembly"). This module is the pure half,
// so the test suite can load it without a Supabase client. The writer,
// recordReassembly in lib.js, reads the two probes and applies what this fold
// decides, best-effort after each asset reconcile.
//
// The reconcile already knows what each run changed. From those sets, two
// kinds of event:
//
//   * a PACK: a hull with a memory vanished, and in the same run a packaged
//     stack of its type at the same place appeared or grew. The memory waits
//     on a pending item_memory_pack row. A hull that vanished with no stack
//     taking it was destroyed or traded away assembled, which is not a pack.
//   * an UNPACK: an assembled hull made its debut. Its memory is found by
//     the rules below, in order; the first rule with any candidate decides.
//     One candidate is carried. Several are left for the owner to settle
//     through remember_ship's inherit_from, because the game itself can no
//     longer tell two hulls of one type apart once they share a stack.
//
// The matcher never looks at the id: it works whether EVE keeps an item id
// through a repackage (is_singleton flips on one row, the memory never left,
// and only a merge into a stack reaches here) or replaces it.

// What the reconcile saw of one item this run. `locationId` is the place as
// ESI gives it (a station, structure or the parent item); `previousQuantity`
// is set on a changed row only.
/**
 * @typedef {{ itemId: number, typeId: number, locationId: number | null, quantity: number,
 *   isSingleton: boolean | null, previousQuantity?: number }} Seen
 * @typedef {{ kind: string, id: string }} OwnerRef
 * @typedef {{ id: number, itemId: number, typeId: number, owner: OwnerRef,
 *   stackItemId: number | null, locationId: number | null }} PendingPack
 * @typedef {{ itemId: number, typeId: number, stackItemId: number | null, locationId: number | null,
 *   packedAt: string }} Pack
 * @typedef {{ fromItemId: number, packId: number | null }} Candidate
 * @typedef {{ fromItemId: number, toItemId: number, packId: number | null, rule: string | null }} Carry
 * @typedef {{ toItemId: number, rule: string | null, candidates: number[] }} Ambiguous
 * @typedef {{ owner: OwnerRef, vanished: Seen[], debuts: Seen[], changed: Seen[],
 *   memories: Map<number, number>, pendingPacks: PendingPack[], now: string }} RunInput
 */

const asNumber = (v) => (v == null ? null : Number(v))

// A packaged stack is any non-singleton row. Appeared (a debut) or grew (a
// changed row with more units than before) is a stack that could have taken
// a hull; shrank (fewer units, or gone) is one a hull could have come out of.
const isStack = (row) => row.isSingleton === false
const grew = (row) => isStack(row) && row.previousQuantity != null && row.quantity > row.previousQuantity
const shrank = (row) => isStack(row) && row.previousQuantity != null && row.quantity < row.previousQuantity

const samePlace = (a, b) => asNumber(a) != null && asNumber(a) === asNumber(b)
const sameOwner = (a, b) => a.kind === b.kind && String(a.id) === String(b.id)

// Stacks of one type at one place that took hulls this run: the debuts of
// stacks plus the stacks that grew.
const stacksTaking = (debuts, changed, typeId, locationId) =>
  filter(
    (s) => Number(s.typeId) === Number(typeId) && samePlace(s.locationId, locationId),
    [...filter(isStack, debuts), ...filter(grew, changed)]
  )

// Did any stack of this type at this place change at all this run? Rule 1
// asks, because a hull that left for a stack is a pack, not a hull that was
// repackaged and reassembled between two extracts.
const anyStackChanged = (debuts, changed, vanished, typeId, locationId) =>
  [...filter(isStack, debuts), ...filter(isStack, changed), ...filter(isStack, vanished)].some(
    (s) => Number(s.typeId) === Number(typeId) && samePlace(s.locationId, locationId)
  )

// The pack events of a run: for every vanished hull that holds a memory, the
// stack that took it. `memories` maps the vanished item ids that hold a
// memory to their type. The hull's own singleton flag is not consulted: if
// EVE keeps the id through a repackage, the memory sits on a packaged row of
// one unit until that row merges into a stack, and that merge is a pack too.
// With one stack the pack names it (rule 2 later follows that stack wherever
// it goes); with several the pack still records the place (rule 3), and no
// stack.
/** @param {RunInput} input @returns {Pack[]} */
export const packsOf = ({ vanished, debuts, changed, memories, now }) =>
  reduce(
    /** @param {Pack[]} acc @param {Seen} hull */
    (acc, hull) => {
      if (!memories.has(Number(hull.itemId))) return acc
      const stacks = stacksTaking(debuts, changed, hull.typeId, hull.locationId)
      if (stacks.length === 0) return acc
      acc.push({
        itemId: Number(hull.itemId),
        typeId: Number(hull.typeId),
        stackItemId: stacks.length === 1 ? Number(stacks[0].itemId) : null,
        locationId: asNumber(hull.locationId),
        packedAt: now,
      })
      return acc
    },
    /** @type {Pack[]} */ ([]),
    vanished
  )

// The candidates for one debut hull, by the first rule that yields any.
//   1. within one interval: a memory-bearing hull of the type vanished this
//      run at the same place under this owner, and no stack of the type at
//      that place changed;
//   2. the stack it went into: a pending pack whose stack shrank or vanished
//      this run, under any owner (a stack keeping its id through a trade
//      takes the memory to the buyer);
//   3. same owner and place: a pending pack of the type under this owner at
//      this place.
/**
 * @param {{ debut: Seen } & Omit<RunInput, 'now'>} input
 * @returns {{ rule: string | null, candidates: Candidate[] }}
 */
const candidatesFor = ({ debut, owner, vanished, debuts, changed, memories, pendingPacks }) => {
  const typeId = Number(debut.typeId)
  const interval = anyStackChanged(debuts, changed, vanished, typeId, debut.locationId)
    ? []
    : filter(
        (h) =>
          memories.has(Number(h.itemId)) && Number(h.typeId) === typeId && samePlace(h.locationId, debut.locationId),
        vanished
      )
  if (interval.length > 0)
    return { rule: 'interval', candidates: map((h) => ({ fromItemId: Number(h.itemId), packId: null }), interval) }

  const shrunkIds = new Set([
    ...map((s) => Number(s.itemId), filter(shrank, changed)),
    ...map((s) => Number(s.itemId), filter(isStack, vanished)),
  ])
  const ofType = filter((p) => Number(p.typeId) === typeId, pendingPacks)
  const byStack = filter((p) => p.stackItemId != null && shrunkIds.has(Number(p.stackItemId)), ofType)
  if (byStack.length > 0)
    return { rule: 'stack', candidates: map((p) => ({ fromItemId: Number(p.itemId), packId: p.id }), byStack) }

  const byPlace = filter((p) => sameOwner(p.owner, owner) && samePlace(p.locationId, debut.locationId), ofType)
  if (byPlace.length > 0)
    return { rule: 'place', candidates: map((p) => ({ fromItemId: Number(p.itemId), packId: p.id }), byPlace) }

  return { rule: null, candidates: [] }
}

// The carries of a run — which debut hull inherits which memory — and the
// debuts left ambiguous. A debut with exactly one candidate carries, unless
// another debut this run claimed the same memory: two hulls assembled from
// one stack cannot both be it, so neither is, and both are listed for the
// owner. A debut is considered only when its type has a candidate at all,
// which keeps the fold to a handful of rows on the rare run that has any.
/** @param {RunInput} input @returns {{ carries: Carry[], ambiguous: Ambiguous[] }} */
export const carriesOf = ({ owner, vanished, debuts, changed, memories, pendingPacks }) => {
  const candidateTypes = new Set([
    ...map(
      (h) => Number(h.typeId),
      filter((h) => memories.has(Number(h.itemId)), vanished)
    ),
    ...map((p) => Number(p.typeId), pendingPacks),
  ])
  const hulls = filter((d) => d.isSingleton === true && candidateTypes.has(Number(d.typeId)), debuts)
  const picks = map((debut) => {
    const { rule, candidates } = candidatesFor({ debut, owner, vanished, debuts, changed, memories, pendingPacks })
    return { toItemId: Number(debut.itemId), rule, candidates }
  }, hulls)

  // A memory two debuts both point at is nobody's.
  const claims = groupBy(
    (c) => String(c.fromItemId),
    picks.flatMap((p) => (p.candidates.length === 1 ? p.candidates : []))
  )
  const contested = new Set(
    Object.entries(claims)
      .filter(([, cs]) => (cs ?? []).length > 1)
      .map(([id]) => Number(id))
  )

  return reduce(
    /** @param {{ carries: Carry[], ambiguous: Ambiguous[] }} acc @param {(typeof picks)[number]} pick */
    (acc, pick) => {
      if (pick.candidates.length === 0) return acc
      const [only] = pick.candidates
      if (pick.candidates.length === 1 && !contested.has(only.fromItemId)) {
        acc.carries.push({ fromItemId: only.fromItemId, toItemId: pick.toItemId, packId: only.packId, rule: pick.rule })
      } else {
        acc.ambiguous.push({
          toItemId: pick.toItemId,
          rule: pick.rule,
          candidates: uniq(map((c) => c.fromItemId, pick.candidates)),
        })
      }
      return acc
    },
    /** @type {{ carries: Carry[], ambiguous: Ambiguous[] }} */ ({ carries: [], ambiguous: [] }),
    picks
  )
}

// Both halves at once: what a run packed and what it carried.
/** @param {RunInput} input */
export const reassemblyEvents = (input) => ({ packs: packsOf(input), ...carriesOf(input) })
