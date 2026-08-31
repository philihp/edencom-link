// List-editing seam for the edit_watched_systems MCP tool
// (docs/mcp-watched-systems.md) — the ordered
// /indexes watch list (public.watched_system, one row per system with a
// `position` the drag UI rewrites) edited by command rather than by dragging.
//
// Like blueprintQuery.ts and planetQuery.ts this module pulls in no I/O — only
// ts-pattern — so every indexing rule below is unit-testable without a
// Supabase client (see test/watchedSystemQuery.test.ts). The tool resolves
// system names, reads the current list, hands it here, and writes back
// whatever plan comes out.
//
// A watch list is modelled as a plain ordered array of system ids; `position`
// is that array's index, and the writer re-densifies it on every edit (see
// writePlan) so a list can never drift into ties or gaps.
import { match } from 'ts-pattern'

export const WATCH_COMMANDS = ['INSERT', 'DELETE', 'UPDATE', 'SELECT'] as const
export type WatchCommand = (typeof WATCH_COMMANDS)[number]

// The three that write. SELECT is planned by selectIndexes instead, since it
// answers with indexes rather than a new list.
export type MutatingCommand = Exclude<WatchCommand, 'SELECT'>

// A watch list is a hand-curated page of sparklines, not a dataset. The cap is
// a guard against a model looping an INSERT, not a product limit.
export const MAX_WATCHED_SYSTEMS = 100

// Where an index actually lands in a list of `length` slots. The bound is
// `length`, not `length - 1`: inserting *at* the end is legal, and that is what
// an omitted index means (append). Out-of-range indexes are pulled in rather
// than refused — "put it last" is a reasonable reading of an index past the
// end, and a negative one of "put it first" — with the adjustment reported so
// the caller can be told. A fractional index truncates toward zero, so 1.9
// means 1, the slot it is inside.
export const clampIndex = (index: number | null | undefined, length: number): number =>
  index == null || !Number.isFinite(index) ? length : Math.max(0, Math.min(Math.trunc(index), length))

// True when clampIndex had to move the caller's index to land it.
const wasClamped = (index: number | null | undefined, landed: number): boolean =>
  index != null && Number.isFinite(index) && Math.trunc(index) !== landed

// The outcome of one INSERT/DELETE/UPDATE against a list.
//
//   ok       the command applied (a refusal carries `message` and leaves `list` alone)
//   changed  the list actually differs — an UPDATE to the index a system already
//            holds is `ok` but not a change, and so needs no write
//   from/to  the system's index before and after; null means "not in the list"
//            on that side, so a DELETE ends at `to: null`
//   note     an advisory about a successful edit (an ignored or adjusted index)
export type EditPlan = {
  ok: boolean
  changed: boolean
  list: number[]
  from: number | null
  to: number | null
  requested: number | null
  clamped: boolean
  message?: string
  note?: string
}

const unchanged = (list: number[], from: number | null, message: string): EditPlan => ({
  ok: false,
  changed: false,
  list,
  from,
  to: from,
  requested: null,
  clamped: false,
  message,
})

// INSERT never reorders: a system already on the list is a refusal pointing at
// UPDATE, which is the command that moves one. That keeps INSERT's promise —
// it only ever adds — and keeps a model from silently reordering a list it
// meant to leave alone.
const insertSystem = (list: number[], systemId: number, index: number | null | undefined): EditPlan => {
  const held = list.indexOf(systemId)
  if (held !== -1) {
    return unchanged(list, held, `Already watched, at index ${held}. Use UPDATE to move it; INSERT only ever adds.`)
  }
  if (list.length >= MAX_WATCHED_SYSTEMS) {
    return unchanged(
      list,
      null,
      `Watch list is full (${MAX_WATCHED_SYSTEMS} systems). DELETE one before adding another.`
    )
  }
  const to = clampIndex(index, list.length)
  return {
    ok: true,
    changed: true,
    list: [...list.slice(0, to), systemId, ...list.slice(to)],
    from: null,
    to,
    requested: index ?? null,
    clamped: wasClamped(index, to),
  }
}

// DELETE takes the system out wherever it sits and ignores the index — there
// is only one row per system, so its position is not part of the identity.
const deleteSystem = (list: number[], systemId: number, index: number | null | undefined): EditPlan => {
  const from = list.indexOf(systemId)
  if (from === -1) return unchanged(list, null, 'Not on the watch list, so there was nothing to delete.')
  return {
    ok: true,
    changed: true,
    list: [...list.slice(0, from), ...list.slice(from + 1)],
    from,
    to: null,
    requested: index ?? null,
    clamped: false,
    ...(index != null && { note: 'DELETE ignores the index — a system is removed from wherever it sits.' }),
  }
}

// UPDATE is a move: delete first, then insert into what's left. The index is
// therefore read against the *resulting* list, which is the reading that makes
// the obvious invariant hold — after UPDATE(x, i) a SELECT of x returns i
// (clamped to the list's bounds). Sliding a system down does not lose a slot
// to its own removal: in [A,B,C,D], UPDATE(A, 2) gives [B,C,A,D], not [B,A,C,D].
//
// A system that isn't watched yet is added rather than refused: the caller
// asked for it to end up at an index, and that is what it gets (noted in the
// reply, since it wasn't a move).
const updateSystem = (list: number[], systemId: number, index: number | null | undefined): EditPlan => {
  const from = list.indexOf(systemId)
  if (from === -1 && list.length >= MAX_WATCHED_SYSTEMS) {
    return unchanged(
      list,
      null,
      `Watch list is full (${MAX_WATCHED_SYSTEMS} systems). DELETE one before adding another.`
    )
  }
  const without = from === -1 ? [...list] : [...list.slice(0, from), ...list.slice(from + 1)]
  const to = clampIndex(index, without.length)
  return {
    ok: true,
    changed: from !== to,
    list: [...without.slice(0, to), systemId, ...without.slice(to)],
    from: from === -1 ? null : from,
    to,
    requested: index ?? null,
    clamped: wasClamped(index, to),
    ...(from === -1 && { note: 'It was not on the watch list, so UPDATE added it at that index.' }),
  }
}

export const planEdit = (list: number[], command: MutatingCommand, systemId: number, index?: number | null): EditPlan =>
  match(command)
    .with('INSERT', () => insertSystem(list, systemId, index))
    .with('DELETE', () => deleteSystem(list, systemId, index))
    .with('UPDATE', () => updateSystem(list, systemId, index))
    .exhaustive()

// SELECT. One row of indexes per system the caller asked about, in watch-list
// order — hence a 2-D array for a 2-D question. A row is a list rather than a
// single index because a name is resolved fuzzily and can match several systems
// (and a system that isn't watched matches none), so "where is EKPB" has to be
// able to answer with nothing, one index, or several.
export const selectIndexes = (list: number[], candidates: number[][]): number[][] =>
  candidates.map((ids) => {
    const wanted = new Set(ids)
    return list.flatMap((id, i) => (wanted.has(id) ? [i] : []))
  })

// What the edit costs in writes: the rows to delete, and every surviving row
// with the position it should now hold. Positions are rewritten wholesale
// rather than diffed — the list is small, and a dense 0..n-1 rewrite also
// repairs a list whose stored positions were degenerate (every row defaults to
// 0 until something orders them), which a minimal diff would preserve.
export type WritePlan = { deleted: number[]; positions: Array<{ systemId: number; position: number }> }

export const writePlan = (before: number[], after: number[]): WritePlan => {
  const kept = new Set(after)
  return {
    deleted: before.filter((id) => !kept.has(id)),
    positions: after.map((systemId, position) => ({ systemId, position })),
  }
}
