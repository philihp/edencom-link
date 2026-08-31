# `edit_watched_systems` — the watch list as an MCP tool

Status: shipped
Owner: philihp

## Why

`watched_system` is a short, ordered, per-user list of solar systems. It does
two jobs: `/indexes` renders one sparkline row per entry, and the
`industry-systems` extract pulls the union of everyone's watch lists each run,
so a system on someone's list is a system with cost-index history. It is also
what `industry_cost_indices` reports on when the caller names no system.

Until now it could only be curated in a browser — a search box to add, a drag
to reorder, a button to remove. A model could read the indices but not fix the
list they came from, which made "start tracking EKPB-3 for me" a task that had
to leave the conversation.

## The tool

Three parameters, on purpose — the list is small enough that a command verb
plus a subject plus a position says everything.

| Parameter | Meaning                                                                |
| --------- | ---------------------------------------------------------------------- |
| `command` | `INSERT`, `DELETE`, `UPDATE` or `SELECT`                                |
| `system`  | a solar system name (`"C-J6MT"`), or an array of them for `SELECT`      |
| `index`   | optional; where the system should end up, counting from 0              |

- **`INSERT`** adds a system at `index`, pushing everything from there down one
  place. It never removes anything, and it never reorders: a system already on
  the list is refused with a pointer at `UPDATE`. No `index` means append.
- **`DELETE`** removes the system from wherever it sits and closes the gap.
  `index` is ignored — there is one row per system, so its position is not part
  of its identity.
- **`UPDATE`** moves a system to `index`. It deletes first, then inserts into
  what is left (see below). A system that isn't watched yet is added rather
  than refused, and says so.
- **`SELECT`** writes nothing. It answers with a **2-D array** — one row of
  indexes per system asked about — because a name is resolved fuzzily and can
  match several systems, or none. With no `system` at all it lists everything
  watched.

## What `index` means

The rule that makes the whole thing predictable: **`index` is read against the
list the caller ends up with, not the one they started from.** After
`INSERT(x, i)` or `UPDATE(x, i)`, a `SELECT` of `x` answers `i`.

For `INSERT` that is uncontroversial — `INSERT('EKPB-3', 2)` puts it after the
systems at 0 and 1 and before the one that was at 2.

For `UPDATE` it is the whole argument, because a move deletes a slot before it
fills one. Starting from `[A, B, C, D]`, `UPDATE(A, 2)`:

```
delete A   → [B, C, D]
insert at 2 → [B, C, A, D]      A is at index 2 ✓
```

The other reading — resolving the index against the original list — would put
A before C, at index 1, one short of what was asked for. Every downward move
would land one place high, and only for systems that started above the target.
That is the kind of off-by-one nobody notices until the list is wrong, so
`test/watchedSystemQuery.test.ts` pins it exhaustively: for a four-system list,
every system moved to every index lands exactly there, keeps the list the same
length, and loses nothing.

Out-of-range indexes are pulled to the nearest end rather than refused ("put it
last" and "put it first" are the reasonable readings), with the adjustment
reported back so it can be explained.

## Writes

`watched_system`'s RLS policy is `user_id = auth.uid()` for all commands, and
the tool writes on the caller's bearer client, so it is scoped exactly like the
`/indexes` server actions' cookie session. System ids come from the SDE mirror
(`searchSdeSystems`), never from the caller, so an id that isn't a real
known-space system cannot be written — which also means wormhole systems can't
be watched, the same limit the web search box has.

Every edit rewrites the whole surviving list's `position` densely from zero
(`writePlan`), rather than diffing. The list is short, and a full rewrite also
repairs a list whose stored positions are still on the add-column default of
`0` — a minimal diff would preserve the tie.

## Layout

- `src/app/api/mcp/watchedSystemQuery.ts` — pure seam: clamping, the three
  edits, `selectIndexes`, `writePlan`. No I/O.
- `src/app/api/mcp/watchedSystemTools.ts` — name resolution, the reads and
  writes, the tool registration.
- `test/watchedSystemQuery.test.ts` — the indexing rules.
