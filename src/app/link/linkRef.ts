// Which link an edit is aimed at, and what that edit changes.
//
// The MCP `update_link` tool is handed whatever the human called the link
// ("my fuel link", the name as saved, an id copied from a URL) plus the fields
// they want different. Two decisions live here, both pure so they're testable
// without a client (test/linkRef.test.ts):
//
//   * resolveLinkRef — turn that reference into exactly one of the caller's own
//     links, or refuse. Never a guess: overwriting the wrong saved query is
//     the failure this is guarding against.
//   * linkEdits — decide which columns an update actually touches. Absent means
//     unchanged, which is what makes "rename it" a rename rather than a rewrite
//     that silently drops the query.
//
// Pure module (./match.ts only).
import { pickOne, type Picked } from './match.ts'

export type LinkSummary = { id: string; name: string }

// A reference to one of the caller's links: its uuid, or its name.
export const resolveLinkRef = (reference: string, links: LinkSummary[]): Picked => pickOne(reference, links, 'link')

export type LinkEditRequest = {
  name?: string
  query?: string
  variables?: Record<string, unknown>
}

export type LinkEdits = {
  // Only the columns that were actually asked to change.
  changes: { name?: string; query?: string; variables?: Record<string, unknown> }
  // What to run for the preview: the new query if there is one, else the
  // stored query — an edit that only changes the audience still gets checked
  // against what the link will actually return.
  effective: { query: string; variables: Record<string, unknown> }
  changed: string[]
}

// Fold a partial edit over the stored row.
//
// A blank name is dropped rather than saved: it would leave the link
// unidentifiable in a list, and every caller that meant to clear it meant
// something else. Variables are replaced wholesale when given, never merged —
// a query's variables are one object the creator reviewed, and half-updating
// them produces a state nobody asked for.
export const linkEdits = (
  request: LinkEditRequest,
  stored: { query: string; variables: Record<string, unknown> }
): LinkEdits => {
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
