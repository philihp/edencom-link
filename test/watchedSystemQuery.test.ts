// Unit coverage for the edit_watched_systems seam.
//
// The whole tool is an indexing argument, so this is where it gets settled.
// The contract worth pinning, and the reason UPDATE gets so much of the file:
// after INSERT(x, i) or UPDATE(x, i), a SELECT of x answers i — the index is
// read against the list the caller ends up with, not the one they started
// from. That is what stops a downward move from losing a slot to its own
// removal (in [A,B,C,D], UPDATE(A, 2) is [B,C,A,D], not [B,A,C,D]).
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  clampIndex,
  MAX_WATCHED_SYSTEMS,
  planEdit,
  selectIndexes,
  writePlan,
  type EditPlan,
} from '../src/app/api/mcp/watchedSystemQuery.ts'

// Real system ids would make every assertion unreadable, so the list is
// spelled with single digits standing in for systems. The seam only ever
// compares ids for equality.
const A = 1
const B = 2
const C = 3
const D = 4
const E = 5

const LIST = [A, B, C, D]

// The invariant the tool promises, checked directly rather than inferred from
// the returned list: where does a SELECT find it afterwards?
const indexIn = (list: number[], systemId: number): number => list.indexOf(systemId)

const apply = (list: number[], command: 'INSERT' | 'DELETE' | 'UPDATE', systemId: number, index?: number | null) =>
  planEdit(list, command, systemId, index)

// ── clampIndex ────────────────────────────────────────────────────────────

test('clampIndex appends when no index is given', () => {
  assert.equal(clampIndex(undefined, 4), 4)
  assert.equal(clampIndex(null, 4), 4)
})

test('clampIndex allows the one-past-the-end slot but no further', () => {
  assert.equal(clampIndex(4, 4), 4)
  assert.equal(clampIndex(5, 4), 4)
  assert.equal(clampIndex(999, 4), 4)
})

test('clampIndex pulls a negative index to the front', () => {
  assert.equal(clampIndex(-1, 4), 0)
  assert.equal(clampIndex(-999, 4), 0)
})

test('clampIndex truncates a fractional index toward zero', () => {
  assert.equal(clampIndex(1.9, 4), 1)
  assert.equal(clampIndex(-0.5, 4), 0)
})

test('clampIndex handles the empty list', () => {
  assert.equal(clampIndex(0, 0), 0)
  assert.equal(clampIndex(7, 0), 0)
  assert.equal(clampIndex(undefined, 0), 0)
})

test('clampIndex treats a non-finite index as absent', () => {
  assert.equal(clampIndex(Number.NaN, 4), 4)
  assert.equal(clampIndex(Number.POSITIVE_INFINITY, 4), 4)
})

// ── INSERT ────────────────────────────────────────────────────────────────

test('INSERT puts the system at the index it asked for, pushing the rest along', () => {
  const plan = apply(LIST, 'INSERT', E, 2)
  assert.equal(plan.ok, true)
  assert.equal(plan.changed, true)
  assert.deepEqual(plan.list, [A, B, E, C, D])
  assert.equal(plan.to, 2)
  assert.equal(plan.from, null)
  assert.equal(indexIn(plan.list, E), 2)
})

test('INSERT deletes nothing — every previously watched system survives', () => {
  const plan = apply(LIST, 'INSERT', E, 0)
  assert.deepEqual(plan.list, [E, A, B, C, D])
  LIST.forEach((id) => assert.ok(plan.list.includes(id)))
  assert.equal(plan.list.length, LIST.length + 1)
})

test('INSERT with no index appends', () => {
  const plan = apply(LIST, 'INSERT', E)
  assert.deepEqual(plan.list, [A, B, C, D, E])
  assert.equal(plan.to, 4)
  assert.equal(plan.clamped, false)
})

test('INSERT at the length index appends without being called clamped', () => {
  const plan = apply(LIST, 'INSERT', E, 4)
  assert.deepEqual(plan.list, [A, B, C, D, E])
  assert.equal(plan.clamped, false)
})

test('INSERT past the end lands last and says it was clamped', () => {
  const plan = apply(LIST, 'INSERT', E, 99)
  assert.deepEqual(plan.list, [A, B, C, D, E])
  assert.equal(plan.to, 4)
  assert.equal(plan.clamped, true)
  assert.equal(plan.requested, 99)
})

test('INSERT with a negative index lands first and says it was clamped', () => {
  const plan = apply(LIST, 'INSERT', E, -3)
  assert.deepEqual(plan.list, [E, A, B, C, D])
  assert.equal(plan.to, 0)
  assert.equal(plan.clamped, true)
})

test('INSERT into an empty list works at any index', () => {
  assert.deepEqual(apply([], 'INSERT', A, 5).list, [A])
  assert.deepEqual(apply([], 'INSERT', A).list, [A])
  assert.deepEqual(apply([], 'INSERT', A, 0).list, [A])
})

test('INSERT refuses a system already watched and points at UPDATE', () => {
  const plan = apply(LIST, 'INSERT', C, 0)
  assert.equal(plan.ok, false)
  assert.equal(plan.changed, false)
  assert.deepEqual(plan.list, LIST)
  assert.equal(plan.from, 2)
  assert.match(plan.message ?? '', /index 2/)
  assert.match(plan.message ?? '', /UPDATE/)
})

test('INSERT refuses once the list is full', () => {
  const full = Array.from({ length: MAX_WATCHED_SYSTEMS }, (_, i) => 100 + i)
  const plan = apply(full, 'INSERT', A, 0)
  assert.equal(plan.ok, false)
  assert.deepEqual(plan.list, full)
  assert.match(plan.message ?? '', /full/)
})

// ── DELETE ────────────────────────────────────────────────────────────────

test('DELETE removes the system wherever it sits and closes the gap', () => {
  const plan = apply(LIST, 'DELETE', B)
  assert.equal(plan.ok, true)
  assert.deepEqual(plan.list, [A, C, D])
  assert.equal(plan.from, 1)
  assert.equal(plan.to, null)
  assert.equal(indexIn(plan.list, C), 1)
})

test('DELETE ignores the index entirely', () => {
  const byIndex = apply(LIST, 'DELETE', D, 0)
  assert.deepEqual(byIndex.list, [A, B, C])
  assert.deepEqual(apply(LIST, 'DELETE', D, 99).list, [A, B, C])
  assert.deepEqual(apply(LIST, 'DELETE', D).list, [A, B, C])
  assert.match(byIndex.note ?? '', /ignores the index/)
})

test('DELETE of an unwatched system changes nothing', () => {
  const plan = apply(LIST, 'DELETE', E)
  assert.equal(plan.ok, false)
  assert.equal(plan.changed, false)
  assert.deepEqual(plan.list, LIST)
  assert.equal(plan.from, null)
})

test('DELETE is idempotent — the second one is simply a no-op', () => {
  const first = apply(LIST, 'DELETE', A)
  const second = apply(first.list, 'DELETE', A)
  assert.deepEqual(second.list, first.list)
  assert.equal(second.changed, false)
})

// ── UPDATE ────────────────────────────────────────────────────────────────

test('UPDATE lands the system on exactly the index asked for, moving down', () => {
  const plan = apply(LIST, 'UPDATE', A, 2)
  assert.equal(plan.ok, true)
  assert.equal(plan.changed, true)
  assert.deepEqual(plan.list, [B, C, A, D])
  assert.equal(plan.from, 0)
  assert.equal(plan.to, 2)
  assert.equal(indexIn(plan.list, A), 2)
})

test('UPDATE lands the system on exactly the index asked for, moving up', () => {
  const plan = apply(LIST, 'UPDATE', D, 1)
  assert.deepEqual(plan.list, [A, D, B, C])
  assert.equal(plan.from, 3)
  assert.equal(plan.to, 1)
  assert.equal(indexIn(plan.list, D), 1)
})

test('UPDATE to every index in a four-system list lands where it says', () => {
  // The invariant, exhaustively: any system, any legal index, ends up there.
  LIST.forEach((systemId) => {
    LIST.forEach((_, index) => {
      const plan = apply(LIST, 'UPDATE', systemId, index)
      assert.equal(plan.to, index)
      assert.equal(indexIn(plan.list, systemId), index, `${systemId} → ${index}`)
      // Nothing is gained or lost by a move, only reordered.
      assert.deepEqual([...plan.list].sort(), [...LIST].sort())
      assert.equal(plan.list.length, LIST.length)
    })
  })
})

test('UPDATE to the last index moves the system to the end', () => {
  const plan = apply(LIST, 'UPDATE', A, 3)
  assert.deepEqual(plan.list, [B, C, D, A])
  assert.equal(indexIn(plan.list, A), 3)
})

test('UPDATE past the end lands last, clamped to the post-move length', () => {
  const plan = apply(LIST, 'UPDATE', A, 99)
  assert.deepEqual(plan.list, [B, C, D, A])
  assert.equal(plan.to, 3)
  assert.equal(plan.clamped, true)
})

test('UPDATE with no index moves the system to the end', () => {
  const plan = apply(LIST, 'UPDATE', B)
  assert.deepEqual(plan.list, [A, C, D, B])
  assert.equal(plan.to, 3)
  assert.equal(plan.clamped, false)
})

test('UPDATE with a negative index moves the system to the front', () => {
  const plan = apply(LIST, 'UPDATE', C, -1)
  assert.deepEqual(plan.list, [C, A, B, D])
  assert.equal(plan.to, 0)
  assert.equal(plan.clamped, true)
})

test('UPDATE to the index a system already holds is a no-op, not a rewrite', () => {
  const plan = apply(LIST, 'UPDATE', C, 2)
  assert.equal(plan.ok, true)
  assert.equal(plan.changed, false)
  assert.deepEqual(plan.list, LIST)
  assert.equal(plan.from, 2)
  assert.equal(plan.to, 2)
})

test('UPDATE does not lose a slot to its own removal', () => {
  // The bug this seam exists to prevent: reading the index against the
  // pre-delete list would put A at 1 here, one short of what was asked for.
  const plan = apply(LIST, 'UPDATE', A, 1)
  assert.deepEqual(plan.list, [B, A, C, D])
  assert.equal(indexIn(plan.list, A), 1)
})

test('UPDATE moving down by one swaps with the next system', () => {
  assert.deepEqual(apply(LIST, 'UPDATE', B, 2).list, [A, C, B, D])
})

test('UPDATE moving up by one swaps with the previous system', () => {
  assert.deepEqual(apply(LIST, 'UPDATE', C, 1).list, [A, C, B, D])
})

test('UPDATE adds a system that was not watched, and says so', () => {
  const plan = apply(LIST, 'UPDATE', E, 1)
  assert.equal(plan.ok, true)
  assert.equal(plan.changed, true)
  assert.deepEqual(plan.list, [A, E, B, C, D])
  assert.equal(plan.from, null)
  assert.equal(plan.to, 1)
  assert.match(plan.note ?? '', /not on the watch list/i)
})

test('UPDATE of an unwatched system past the end appends it', () => {
  const plan = apply(LIST, 'UPDATE', E, 99)
  assert.deepEqual(plan.list, [A, B, C, D, E])
  assert.equal(plan.to, 4)
})

test('UPDATE refuses to add to a full list, but still moves within one', () => {
  const full = Array.from({ length: MAX_WATCHED_SYSTEMS }, (_, i) => 100 + i)
  const refused = apply(full, 'UPDATE', A, 0)
  assert.equal(refused.ok, false)
  assert.deepEqual(refused.list, full)

  const moved = apply(full, 'UPDATE', full[MAX_WATCHED_SYSTEMS - 1], 0)
  assert.equal(moved.ok, true)
  assert.equal(moved.list.length, MAX_WATCHED_SYSTEMS)
  assert.equal(moved.list[0], full[MAX_WATCHED_SYSTEMS - 1])
})

test('UPDATE in a single-system list is a no-op at any index', () => {
  ;[0, 5, -5, undefined].forEach((index) => {
    const plan = apply([A], 'UPDATE', A, index as number | undefined)
    assert.deepEqual(plan.list, [A])
    assert.equal(plan.to, 0)
    assert.equal(plan.changed, false)
  })
})

test('UPDATE round-trips: moving away and back restores the order', () => {
  const away = apply(LIST, 'UPDATE', A, 3)
  const back = apply(away.list, 'UPDATE', A, 0)
  assert.deepEqual(back.list, LIST)
})

test('UPDATE is idempotent — repeating it changes nothing the second time', () => {
  const once = apply(LIST, 'UPDATE', D, 0)
  const twice = apply(once.list, 'UPDATE', D, 0)
  assert.deepEqual(twice.list, once.list)
  assert.equal(twice.changed, false)
})

test('UPDATE equals DELETE-then-INSERT at the same index', () => {
  // The behaviour as described: UPDATE is an INSERT that deletes first.
  LIST.forEach((systemId) => {
    ;[0, 1, 2, 3].forEach((index) => {
      const deleted = apply(LIST, 'DELETE', systemId)
      const inserted = apply(deleted.list, 'INSERT', systemId, index)
      assert.deepEqual(apply(LIST, 'UPDATE', systemId, index).list, inserted.list)
    })
  })
})

// ── SELECT ────────────────────────────────────────────────────────────────

test('selectIndexes answers one row of indexes per system asked about', () => {
  assert.deepEqual(selectIndexes(LIST, [[C], [A]]), [[2], [0]])
})

test('selectIndexes gives an empty row for a system that is not watched', () => {
  assert.deepEqual(selectIndexes(LIST, [[E]]), [[]])
})

test('selectIndexes reports every match when a name resolved to several systems', () => {
  assert.deepEqual(selectIndexes(LIST, [[B, D]]), [[1, 3]])
})

test('selectIndexes returns indexes in watch-list order, not query order', () => {
  assert.deepEqual(selectIndexes(LIST, [[D, A]]), [[0, 3]])
})

test('selectIndexes is a 2-D answer even for one system', () => {
  const answer = selectIndexes(LIST, [[A]])
  assert.equal(answer.length, 1)
  assert.ok(Array.isArray(answer[0]))
})

test('selectIndexes over an empty watch list gives an empty row per query', () => {
  assert.deepEqual(selectIndexes([], [[A], [B]]), [[], []])
})

test('selectIndexes with no queries gives no rows', () => {
  assert.deepEqual(selectIndexes(LIST, []), [])
})

test('selectIndexes deduplicates candidates that hit the same watched system', () => {
  assert.deepEqual(selectIndexes(LIST, [[A, A]]), [[0]])
})

// ── writePlan ─────────────────────────────────────────────────────────────

test('writePlan renumbers every surviving row densely from zero', () => {
  assert.deepEqual(writePlan(LIST, [B, C, A, D]), {
    deleted: [],
    positions: [
      { systemId: B, position: 0 },
      { systemId: C, position: 1 },
      { systemId: A, position: 2 },
      { systemId: D, position: 3 },
    ],
  })
})

test('writePlan names the rows a DELETE dropped', () => {
  const plan = writePlan(LIST, [A, C, D])
  assert.deepEqual(plan.deleted, [B])
  assert.deepEqual(
    plan.positions.map((p) => p.position),
    [0, 1, 2]
  )
})

test('writePlan clearing the whole list deletes everything and writes nothing', () => {
  assert.deepEqual(writePlan(LIST, []), { deleted: LIST, positions: [] })
})

test('writePlan on a first INSERT deletes nothing', () => {
  assert.deepEqual(writePlan([], [A]), { deleted: [], positions: [{ systemId: A, position: 0 }] })
})

// ── End-to-end over the four commands ─────────────────────────────────────

test('a session of commands leaves a list that SELECT agrees with', () => {
  const steps: Array<['INSERT' | 'DELETE' | 'UPDATE', number, number | undefined]> = [
    ['INSERT', A, undefined],
    ['INSERT', B, undefined],
    ['INSERT', C, 1],
    ['UPDATE', A, 2],
    ['DELETE', B, undefined],
    ['INSERT', D, 0],
  ]
  const final = steps.reduce<EditPlan>(
    (plan, [command, systemId, index]) => planEdit(plan.list, command, systemId, index),
    { ok: true, changed: false, list: [], from: null, to: null, requested: null, clamped: false }
  )
  assert.deepEqual(final.list, [D, C, A])
  assert.deepEqual(selectIndexes(final.list, [[D], [C], [A], [B]]), [[0], [1], [2], []])
})
