// Pure argument→filter shaping for the GraphQL resolvers — no I/O imports so
// test/graphqlFilters.test.ts can exercise it under the node test runner.
// These mirror the MCP layer's resolveOwnerFilter/limit semantics but can't
// import src/app/api/mcp/lib.ts, whose transitive imports (next/headers,
// Supabase) don't load outside Next.

// Hard caps keep a single request bounded regardless of the limit argument;
// filters, not paging, are how callers narrow further.
export const ASSET_CAP = 5000
export const LIST_CAP = 1000

// Clamp a caller-supplied limit into [1, cap]; absent means the cap itself.
export const clampLimit = (limit: number | null | undefined, cap: number): number => {
  if (limit == null || !Number.isFinite(limit)) return cap
  return Math.min(Math.max(1, Math.floor(limit)), cap)
}

// Case-insensitive substring match of an owner-name filter against the
// caller's characters. Returns the matching registration ids, or an error
// listing what's available — same semantics as the MCP resolveOwnerFilter.
export type OwnerMatch = { ok: true; ids: string[] | null } | { ok: false; message: string }

export const matchOwnerIds = (owner: string | null | undefined, nameById: Map<string, string>): OwnerMatch => {
  const trimmed = (owner ?? '').trim().toLowerCase()
  if (trimmed === '') return { ok: true, ids: null }
  const ids = [...nameById].filter(([, name]) => name.toLowerCase().includes(trimmed)).map(([id]) => id)
  if (ids.length === 0) {
    const available = [...nameById.values()].sort((a, b) => a.localeCompare(b))
    return { ok: false, message: `No character matched "${owner}". Available: ${available.join(', ')}.` }
  }
  return { ok: true, ids }
}

// Parse the `since` argument (full ISO timestamp or a date prefix) into an
// ISO string usable as a >= bound, or reject with a hint.
export type SinceParse = { ok: true; iso: string | null } | { ok: false; message: string }

export const parseSince = (since: string | null | undefined): SinceParse => {
  const trimmed = (since ?? '').trim()
  if (trimmed === '') return { ok: true, iso: null }
  const parsed = new Date(trimmed)
  if (Number.isNaN(parsed.getTime())) {
    return {
      ok: false,
      message: `Could not parse since="${since}" — use an ISO date like 2026-08-01 or a full timestamp.`,
    }
  }
  return { ok: true, iso: parsed.toISOString() }
}

// A numeric id argument (GraphQL String, since EVE ids overflow Int). Rejects
// anything that isn't a plain positive integer literal.
export type IdParse = { ok: true; id: string | null } | { ok: false; message: string }

export const parseIdArg = (raw: string | null | undefined, label: string): IdParse => {
  const trimmed = (raw ?? '').trim()
  if (trimmed === '') return { ok: true, id: null }
  if (!/^\d+$/.test(trimmed)) return { ok: false, message: `${label} must be a numeric id, got "${raw}".` }
  return { ok: true, id: trimmed }
}

// The two ways to name item types, resolved to one filter. They are mutually
// EXCLUSIVE rather than unioned: typeIds asks an exact question and typeName a
// fuzzy one (it substring-matches the SDE, so "Fuel Block" also catches the
// blueprints), and a lens whose stored query silently blends both is a lens
// nobody can predict a year later. Returns the exact ids when given, `null`
// for "no id filter" (the caller then applies its fuzzy typeName path), and an
// error when both or a malformed id arrive.
export type TypeIdsParse = { ok: true; ids: number[] | null } | { ok: false; message: string }

export const parseTypeIdsArg = (
  typeIds: readonly string[] | null | undefined,
  typeName: string | null | undefined
): TypeIdsParse => {
  const ids = (typeIds ?? []).map((id) => (id ?? '').trim()).filter((id) => id !== '')
  if (ids.length === 0) return { ok: true, ids: null }
  if ((typeName ?? '').trim() !== '') {
    return { ok: false, message: 'Pass typeIds or typeName, not both — one is exact, the other is a name search.' }
  }
  const bad = ids.find((id) => !/^\d+$/.test(id))
  if (bad !== undefined) return { ok: false, message: `typeIds must be numeric ids, got "${bad}".` }
  return { ok: true, ids: [...new Set(ids.map(Number))] }
}
