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

// Case-insensitive substring match of the `character:` filter against the
// caller's characters. Returns the matching registration ids, or an error
// listing what's available — same semantics as the MCP resolveOwnerFilter.
export type CharacterMatch = { ok: true; ids: string[] | null } | { ok: false; message: string }

export const matchCharacterName = (
  character: string | null | undefined,
  nameById: ReadonlyMap<string, string>
): CharacterMatch => {
  const trimmed = (character ?? '').trim().toLowerCase()
  if (trimmed === '') return { ok: true, ids: null }
  const ids = [...nameById].filter(([, name]) => name.toLowerCase().includes(trimmed)).map(([id]) => id)
  if (ids.length === 0) {
    const available = [...nameById.values()].sort((a, b) => a.localeCompare(b))
    return { ok: false, message: `No character matched "${character}". Available: ${available.join(', ')}.` }
  }
  return { ok: true, ids }
}

// The exact counterpart of the fuzzy `character:` filter: a LIST of
// characters, each named by whichever id the caller has to hand. An entry is
//
//   - all digits          → an EVE character id (Owner.characterId),
//   - a uuid              → this site's registration id (Owner.id / ownerId),
//   - anything else       → a character name, matched case-insensitively but
//                           WHOLE — a list is the exact question, `character`
//                           is the fuzzy one, as typeIds is to typeName.
//
// Every entry must match, and an unmatched one errors listing what exists,
// rather than quietly narrowing a lens nobody re-reads for a year. The result
// is the union, deduped, in the caller's order.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type CharacterDirectory = {
  // registration uuid → character name
  nameById: ReadonlyMap<string, string>
  // registration uuid → EVE character id
  characterIdById: ReadonlyMap<string, string>
}

const idsForEntry = (entry: string, { nameById, characterIdById }: CharacterDirectory): string[] => {
  if (/^\d+$/.test(entry)) {
    return [...characterIdById].filter(([, characterId]) => characterId === entry).map(([id]) => id)
  }
  if (UUID.test(entry)) {
    return nameById.has(entry) ? [entry] : []
  }
  const wanted = entry.toLowerCase()
  return [...nameById].filter(([, name]) => name.toLowerCase() === wanted).map(([id]) => id)
}

const availableCharacters = ({ nameById, characterIdById }: CharacterDirectory): string =>
  [...nameById]
    .map(([id, name]) => {
      const characterId = characterIdById.get(id)
      return characterId === undefined ? name : `${name} (${characterId})`
    })
    .sort((a, b) => a.localeCompare(b))
    .join(', ')

export const matchCharacterRefs = (
  characters: readonly string[] | null | undefined,
  directory: CharacterDirectory
): CharacterMatch => {
  const entries = (characters ?? []).map((c) => (c ?? '').trim()).filter((c) => c !== '')
  if (entries.length === 0) return { ok: true, ids: null }

  const matched = entries.map((entry) => ({ entry, ids: idsForEntry(entry, directory) }))
  const unmatched = matched.filter((m) => m.ids.length === 0).map((m) => m.entry)
  if (unmatched.length > 0) {
    return {
      ok: false,
      message: `No character matched ${unmatched.map((u) => `"${u}"`).join(', ')}. Available: ${availableCharacters(directory)}.`,
    }
  }
  return { ok: true, ids: [...new Set(matched.flatMap((m) => m.ids))] }
}

// The two ways to name characters, resolved to one filter — mutually exclusive
// for the same reason typeIds and typeName are: `character` substring-matches
// and `characters` matches whole names/ids, and a stored lens that blended both
// would be unpredictable a year later.
export const matchCharacterFilter = (
  character: string | null | undefined,
  characters: readonly string[] | null | undefined,
  directory: CharacterDirectory
): CharacterMatch => {
  const listed = (characters ?? []).some((c) => (c ?? '').trim() !== '')
  if (!listed) return matchCharacterName(character, directory.nameById)
  if ((character ?? '').trim() !== '') {
    return {
      ok: false,
      message: 'Pass character or characters, not both — one is a name search, the other an exact list.',
    }
  }
  return matchCharacterRefs(characters, directory)
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
