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
//   * an UNPACK: a hull was assembled. Measured on production (2026-11-02,
//     docs/ship-memory.md "Reassembly"): EVE gives the assembled hull the
//     packaged row's own id — a stack of one or of thirty-one — so the
//     assembly reaches the reconcile as a CHANGED row whose is_singleton
//     turned true (a FLIP), and the remainder of a larger stack goes on
//     under a new id. A hull also counts as assembled when it DEBUTS as a
//     singleton, for the one case a flip cannot show: a hull repackaged and
//     reassembled between two extracts, whose fresh stack id was never seen
//     as a stack. The memory is found by the rules below, in order; the
//     first rule with any candidate decides. One candidate is carried.
//     Several are left for the owner to settle through remember_ship's
//     inherit_from, because the game itself can no longer tell two hulls of
//     one type apart once they share a stack.
//
// Because the flipped id IS the stack the pack named, rule 2 on a flip is
// identity rather than inference: a pack alone in its stack is carried with
// certainty, and several packs in one stack are exactly the ambiguous case.
// A debut only ever takes rule 1 (or rule 2 by a stack that shrank, should
// EVE ever hand the remainder the old id instead): a hull arriving assembled
// from a contract or a trade debuts too, and matching it to a pending pack
// by place alone (rule 3) would give it another ship's past.

// What the reconcile saw of one item this run. `locationId` is the place as
// ESI gives it (a station, structure or the parent item); `previousQuantity`
// is set on a changed row only.
/**
 * @typedef {{ itemId: number, typeId: number, locationId: number | null, quantity: number,
 *   isSingleton: boolean | null, previousQuantity?: number, previousSingleton?: boolean | null }} Seen
 * @typedef {{ kind: string, id: string }} OwnerRef
 * @typedef {{ id: number, itemId: number, typeId: number, owner: OwnerRef,
 *   stackItemId: number | null, locationId: number | null }} PendingPack
 * @typedef {{ itemId: number, typeId: number, stackItemId: number | null, locationId: number | null,
 *   packedAt: string }} Pack
 * @typedef {{ fromItemId: number, packId: number | null }} Candidate
 * @typedef {'flip' | 'debut'} Via
 * @typedef {{ fromItemId: number, toItemId: number, packId: number | null, rule: string | null, via: Via }} Carry
 * @typedef {{ toItemId: number, rule: string | null, candidates: number[], via: Via }} Ambiguous
 * @typedef {{ owner: OwnerRef, vanished: Seen[], debuts: Seen[], changed: Seen[],
 *   memories: Map<number, number>, pendingPacks: PendingPack[], now: string }} RunInput
 */

const asNumber = (v) => (v == null ? null : Number(v))

// A packaged stack is any non-singleton row. Appeared (a debut) or grew (a
// changed row with more units than before) is a stack that could have taken
// a hull; shrank (fewer units, or gone) is one a hull could have come out of.
const isStack = (row) => row.isSingleton === false
// A changed row that was a stack and is a hull now: the assembly itself.
const flipped = (row) => row.isSingleton === true && row.previousSingleton === false
const isDebutHull = (row) => row.isSingleton === true
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
// repackaged and reassembled between two extracts. A stack that flipped into
// a hull changed too, though its row no longer reads as a stack.
const anyStackChanged = (debuts, changed, vanished, typeId, locationId) =>
  [...filter(isStack, debuts), ...filter((r) => isStack(r) || flipped(r), changed), ...filter(isStack, vanished)].some(
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

// The candidates for one assembled hull, by the first rule that yields any.
//   1. within one interval (a debut only): a memory-bearing hull of the type
//      vanished this run at the same place under this owner, and no stack of
//      the type at that place changed;
//   2. the stack it went into: for a flip, every pending pack naming the
//      flipped id as its stack — the pack's stack is the hull's own id; for
//      either shape, a pending pack whose stack shrank or vanished this run,
//      under any owner (a stack keeping its id through a trade takes the
//      memory to the buyer);
//   3. same owner and place (a flip only): a pending pack of the type under
//      this owner at this place — the pack that could name no stack because
//      several grew at once.
/**
 * @param {{ hull: Seen, via: Via } & Omit<RunInput, 'now'>} input
 * @returns {{ rule: string | null, candidates: Candidate[] }}
 */
const candidatesFor = ({ hull, via, owner, vanished, debuts, changed, memories, pendingPacks }) => {
  const typeId = Number(hull.typeId)
  const asCandidate = (p) => ({ fromItemId: Number(p.itemId), packId: p.id })

  const interval =
    via !== 'debut' || anyStackChanged(debuts, changed, vanished, typeId, hull.locationId)
      ? []
      : filter(
          (h) =>
            memories.has(Number(h.itemId)) && Number(h.typeId) === typeId && samePlace(h.locationId, hull.locationId),
          vanished
        )
  if (interval.length > 0)
    return { rule: 'interval', candidates: map((h) => ({ fromItemId: Number(h.itemId), packId: null }), interval) }

  const ofType = filter((p) => Number(p.typeId) === typeId, pendingPacks)
  const stackIds = new Set([
    ...(via === 'flip' ? [Number(hull.itemId)] : []),
    ...map((s) => Number(s.itemId), filter(shrank, changed)),
    ...map((s) => Number(s.itemId), filter(isStack, vanished)),
  ])
  const byStack = filter((p) => p.stackItemId != null && stackIds.has(Number(p.stackItemId)), ofType)
  if (byStack.length > 0) return { rule: 'stack', candidates: map(asCandidate, byStack) }

  const byPlace =
    via === 'flip' ? filter((p) => sameOwner(p.owner, owner) && samePlace(p.locationId, hull.locationId), ofType) : []
  if (byPlace.length > 0) return { rule: 'place', candidates: map(asCandidate, byPlace) }

  return { rule: null, candidates: [] }
}

// The carries of a run — which assembled hull inherits which memory — and
// the hulls left ambiguous. A hull with exactly one candidate carries, unless
// another hull this run claimed the same memory: two hulls assembled from
// one stack cannot both be it, so neither is, and both are listed for the
// owner. A hull is considered only when its type has a candidate at all,
// which keeps the fold to a handful of rows on the rare run that has any.
// `via` says which shape the hull arrived in; the writer skips its
// new-id test for a flip, whose closed rows are its own packaged past.
/** @param {RunInput} input @returns {{ carries: Carry[], ambiguous: Ambiguous[] }} */
export const carriesOf = ({ owner, vanished, debuts, changed, memories, pendingPacks }) => {
  const candidateTypes = new Set([
    ...map(
      (h) => Number(h.typeId),
      filter((h) => memories.has(Number(h.itemId)), vanished)
    ),
    ...map((p) => Number(p.typeId), pendingPacks),
  ])
  const ofCandidateType = (r) => candidateTypes.has(Number(r.typeId))
  const hulls = [
    ...map(
      (r) => ({ hull: r, via: /** @type {Via} */ ('flip') }),
      filter((r) => flipped(r) && ofCandidateType(r), changed)
    ),
    ...map(
      (r) => ({ hull: r, via: /** @type {Via} */ ('debut') }),
      filter((r) => isDebutHull(r) && ofCandidateType(r), debuts)
    ),
  ]
  const picks = map(({ hull, via }) => {
    const { rule, candidates } = candidatesFor({ hull, via, owner, vanished, debuts, changed, memories, pendingPacks })
    return { toItemId: Number(hull.itemId), rule, candidates, via }
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
        acc.carries.push({
          fromItemId: only.fromItemId,
          toItemId: pick.toItemId,
          packId: only.packId,
          rule: pick.rule,
          via: pick.via,
        })
      } else {
        acc.ambiguous.push({
          toItemId: pick.toItemId,
          rule: pick.rule,
          candidates: uniq(map((c) => c.fromItemId, pick.candidates)),
          via: pick.via,
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
