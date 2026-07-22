// Shared parsing for the `columns` query param on the IMPORTDATA endpoints
// (/api/character/*, /api/corp/*): lets a caller reorder/subset the columns a
// endpoint returns, e.g. ?columns=type_id,quantity. A missing/empty value
// defaults to the endpoint's normal column set and order, unchanged.

// Parse an optional `columns` query param against an endpoint's own allowed
// column list. A missing/empty value returns `{ columns: null }`, meaning "use
// the default". Returns `{ ok: false }` with a message naming the unknown
// column(s) so the route can answer 400.
export const parseColumnsParam = (
  raw: string | null | undefined,
  allowed: readonly string[]
): { ok: true; columns: string[] | null } | { ok: false; error: string } => {
  const trimmed = raw?.trim()
  if (!trimmed) return { ok: true, columns: null }

  const requested = trimmed
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean)
  const allowedSet = new Set<string>(allowed)
  const unknown = requested.filter((c) => !allowedSet.has(c))
  if (unknown.length > 0) {
    return {
      ok: false,
      error: `Unknown column(s): ${unknown.join(', ')}. Valid columns: ${allowed.join(', ')}`,
    }
  }

  return { ok: true, columns: requested }
}

// Reorders/subsets each row to just `columns`, in that order. `columns: null`
// (no override requested) returns rows unchanged, preserving the endpoint's
// default json_build_object key order.
export const selectColumns = (
  rows: Record<string, unknown>[],
  columns: readonly string[] | null
): Record<string, unknown>[] => {
  if (columns === null) return rows
  return rows.map((row) => Object.fromEntries(columns.map((c) => [c, row[c]])))
}
