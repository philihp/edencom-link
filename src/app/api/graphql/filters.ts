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

// EVERY FILTER DIMENSION IS NAMED THE SAME TWO WAYS — character, location and
// item type all take a singular and a plural argument:
//
//   - the SINGULAR (`character:`, `location:`, `type:`) is a case-insensitive
//     substring SEARCH over names. It may match several things; that's the
//     point — it's how you ask a fuzzy question.
//   - the PLURAL (`characters:`, `locations:`, `types:`) is an EXACT list whose
//     entries are ids or whole names, freely mixed. Every entry must match
//     something, and one that doesn't is an error rather than a silently
//     narrower result.
//
// The two are mutually exclusive: one asks a fuzzy question and the other an
// exact one, and a stored lens that blended them is one nobody can predict a
// year later. Resolving the names is per-dimension (the caller's characters,
// the SDE, the structure caches) and lives with the resolvers; the shaping and
// the refusals are here, where they stay pure and testable.
export type RefQuery = { kind: 'none' } | { kind: 'search'; term: string } | { kind: 'exact'; entries: string[] }

export type RefParse = { ok: true; query: RefQuery } | { ok: false; message: string }

export const parseRefFilter = (
  single: string | null | undefined,
  list: readonly string[] | null | undefined,
  label: string
): RefParse => {
  const term = (single ?? '').trim()
  const entries = (list ?? []).map((e) => (e ?? '').trim()).filter((e) => e !== '')
  if (entries.length === 0) {
    return { ok: true, query: term === '' ? { kind: 'none' } : { kind: 'search', term } }
  }
  if (term !== '') {
    return {
      ok: false,
      message: `Pass ${label} or ${label}s, not both — one is a name search, the other an exact list.`,
    }
  }
  return { ok: true, query: { kind: 'exact', entries: [...new Set(entries)] } }
}

// An exact-list entry is an id when it's a bare positive integer, and a name
// otherwise. (A character may also be named by its registration uuid — see
// matchCharacterRefs, the one dimension with three id forms.)
export const splitRefEntries = (entries: readonly string[]): { ids: string[]; names: string[] } => ({
  ids: entries.filter((e) => /^\d+$/.test(e)),
  names: entries.filter((e) => !/^\d+$/.test(e)),
})

// Whole-name (case-insensitive) matching of exact-list entries against
// whatever the dimension's resolver turned up, keeping every candidate that
// matches — two things really can share a name.
export type NamedRef = { id: string; name: string }

export const matchExactNames = (
  names: readonly string[],
  candidatesFor: (name: string) => readonly NamedRef[]
): { ids: string[]; unmatched: string[] } => {
  const matched = names.map((name) => {
    const wanted = name.toLowerCase()
    return {
      name,
      ids: candidatesFor(name)
        .filter((c) => c.name.toLowerCase() === wanted)
        .map((c) => c.id),
    }
  })
  return {
    ids: [...new Set(matched.flatMap((m) => m.ids))],
    unmatched: matched.filter((m) => m.ids.length === 0).map((m) => m.name),
  }
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

// The character dimension of the two-argument shape above: the singular
// substring-searches the caller's character names, the plural matches whole
// names / EVE character ids / registration ids.
export const matchCharacterFilter = (
  character: string | null | undefined,
  characters: readonly string[] | null | undefined,
  directory: CharacterDirectory
): CharacterMatch => {
  const parsed = parseRefFilter(character, characters, 'character')
  if (!parsed.ok) return { ok: false, message: parsed.message }
  if (parsed.query.kind === 'none') return { ok: true, ids: null }
  if (parsed.query.kind === 'search') return matchCharacterName(parsed.query.term, directory.nameById)
  return matchCharacterRefs(parsed.query.entries, directory)
}

// The corporation dimension, same shape again over the corporations the
// caller's characters belong to: the singular substring-searches their names,
// the plural matches whole names and EVE corporation ids. A corporation has
// only the two id forms (there's no registration uuid behind one), so this is
// simpler than the character matcher, but the refusals are identical.
export const matchCorporationFilter = (
  corporation: string | null | undefined,
  corporations: readonly string[] | null | undefined,
  nameById: ReadonlyMap<string, string>
): CharacterMatch => {
  const parsed = parseRefFilter(corporation, corporations, 'corporation')
  if (!parsed.ok) return { ok: false, message: parsed.message }
  const query = parsed.query
  if (query.kind === 'none') return { ok: true, ids: null }

  const available = (): string =>
    [...nameById]
      .map(([id, name]) => `${name} (${id})`)
      .sort((a, b) => a.localeCompare(b))
      .join(', ')

  if (query.kind === 'search') {
    const wanted = query.term.toLowerCase()
    const ids = [...nameById].filter(([, name]) => name.toLowerCase().includes(wanted)).map(([id]) => id)
    if (ids.length === 0) {
      return { ok: false, message: `No corporation matched "${query.term}". Available: ${available()}.` }
    }
    return { ok: true, ids }
  }

  const { ids, names } = splitRefEntries(query.entries)
  const candidates = [...nameById].map(([id, name]) => ({ id, name }))
  const matchedNames = matchExactNames(names, () => candidates)
  const unknownIds = ids.filter((id) => !nameById.has(id))
  const unmatched = [...unknownIds, ...matchedNames.unmatched]
  if (unmatched.length > 0) {
    return {
      ok: false,
      message: `No corporation matched ${unmatched.map((u) => `"${u}"`).join(', ')}. Available: ${available()}.`,
    }
  }
  return { ok: true, ids: [...new Set([...ids, ...matchedNames.ids])] }
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
