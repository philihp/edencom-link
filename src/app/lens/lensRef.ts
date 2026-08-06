// Which lens an edit is aimed at, and what that edit changes.
//
// The MCP `update_lens` tool is handed whatever the human called the lens
// ("my fuel lens", the name as saved, an id copied from a URL) plus the fields
// they want different. Two decisions live here, both pure so they're testable
// without a client (test/lensRef.test.ts):
//
//   * resolveLensRef — turn that reference into exactly one of the caller's own
//     lenses, or refuse. Never a guess: overwriting the wrong saved query is
//     the failure this is guarding against.
//   * lensEdits — decide which columns an update actually touches. Absent means
//     unchanged, which is what makes "rename it" a rename rather than a rewrite
//     that silently drops the query.
//
// Pure module (./match.ts only).
import { pickOne, type Picked } from './match.ts'

export type LensSummary = { id: string; name: string }

// A reference to one of the caller's lenses: its uuid, or its name.
export const resolveLensRef = (reference: string, lenses: LensSummary[]): Picked => pickOne(reference, lenses, 'lens')

export type LensEditRequest = {
  name?: string
  query?: string
  variables?: Record<string, unknown>
}

export type LensEdits = {
  // Only the columns that were actually asked to change.
  changes: { name?: string; query?: string; variables?: Record<string, unknown> }
  // What to run for the preview: the new query if there is one, else the
  // stored query — an edit that only changes the audience still gets checked
  // against what the lens will actually return.
  effective: { query: string; variables: Record<string, unknown> }
  changed: string[]
}

// Fold a partial edit over the stored row.
//
// A blank name is dropped rather than saved: it would leave the lens
// unidentifiable in a list, and every caller that meant to clear it meant
// something else. Variables are replaced wholesale when given, never merged —
// a query's variables are one object the creator reviewed, and half-updating
// them produces a state nobody asked for.
export const lensEdits = (
  request: LensEditRequest,
  stored: { query: string; variables: Record<string, unknown> }
): LensEdits => {
  const name = request.name?.trim()
  const changes = {
    ...(name ? { name } : {}),
    ...(request.query !== undefined ? { query: request.query } : {}),
    ...(request.variables !== undefined ? { variables: request.variables } : {}),
  }
  return {
    changes,
    effective: {
      query: changes.query ?? stored.query,
      variables: changes.variables ?? stored.variables,
    },
    changed: Object.keys(changes),
  }
}
