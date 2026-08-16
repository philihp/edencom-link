// Pure argument→filter shaping for the GraphQL resolvers — no I/O imports so
// test/graphqlFilters.test.ts can exercise it under the node test runner.
// These mirror the MCP layer's resolveOwnerFilter/limit semantics but can't
// import src/app/api/mcp/lib.ts, whose transitive imports (next/headers,
// Supabase) don't load outside Next.

// Hard caps keep a single request bounded regardless of the limit argument;
// filters, not paging, are how callers narrow further.
export const ASSET_CAP = 5000
export const LIST_CAP = 1000
// The lens CSV surface serves whole result sets — a Sheets =IMPORTDATA() tab
// can't page or narrow — so its context raises both caps to this bound
// (docs/sharing-layer/09-sheets-parity.md). Sized to what the uncapped legacy
// CSV routes already serve inside the same 60s budget; a result that still
// hits it is refused by the route rather than silently shortened.
export const EXPORT_CAP = 50000

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
// otherwise. (An owner entry may also be a registration uuid — see
// matchOwnerFilter, the one dimension with three id forms.)
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

// The caller's characters, by the three ids one can be named by. An exact-list
// entry resolves against these as:
//
//   - all digits          → an EVE character id (Owner.characterId),
//   - a uuid              → this site's registration id (Owner.id / ownerId),
//   - anything else       → a character name, matched case-insensitively but
//                           WHOLE (the plural asks the exact question).
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

// THE OWNER DIMENSION covers both kinds of owner at once, because that's how
// the data reads: an asset, a blueprint or an industry job is owned by a
// character OR by a corporation, and "show me what these three own" shouldn't
// care which. `owner:` substring-searches character AND corporation names;
// `owners:` is an exact list mixing character names, EVE character ids,
// registration ids, corporation names and corporation ids freely.
//
// The result is the two scopes the resolvers read with. `null` means no filter
// at all (read everything the caller owns); a filter that matched only
// characters leaves corporationIds EMPTY, and vice versa — naming one side
// narrows to it, exactly as naming one character narrows to that character.
export type OwnerScopes = { registrationIds: string[]; corporationIds: string[] }
export type OwnerMatch = { ok: true; scopes: OwnerScopes | null } | { ok: false; message: string }

export type OwnerDirectory = {
  characters: CharacterDirectory
  // EVE corporation id → name. A corporation has no registration uuid behind
  // it, so it carries two id forms to a character's three.
  corporations: ReadonlyMap<string, string>
}

const availableOwners = ({ characters, corporations }: OwnerDirectory): string =>
  [
    ...[...characters.nameById].map(([id, name]) => {
      const characterId = characters.characterIdById.get(id)
      return characterId === undefined ? name : `${name} (${characterId})`
    }),
    ...[...corporations].map(([id, name]) => `${name} (${id}, corporation)`),
  ]
    .sort((a, b) => a.localeCompare(b))
    .join(', ')

const corporationIdsForEntry = (entry: string, corporations: ReadonlyMap<string, string>): string[] => {
  if (corporations.has(entry)) return [entry]
  const wanted = entry.toLowerCase()
  return [...corporations].filter(([, name]) => name.toLowerCase() === wanted).map(([id]) => id)
}

export const matchOwnerFilter = (
  owner: string | null | undefined,
  owners: readonly string[] | null | undefined,
  directory: OwnerDirectory
): OwnerMatch => {
  const parsed = parseRefFilter(owner, owners, 'owner')
  if (!parsed.ok) return { ok: false, message: parsed.message }
  const query = parsed.query
  if (query.kind === 'none') return { ok: true, scopes: null }

  if (query.kind === 'search') {
    const wanted = query.term.toLowerCase()
    const registrationIds = [...directory.characters.nameById]
      .filter(([, name]) => name.toLowerCase().includes(wanted))
      .map(([id]) => id)
    const corporationIds = [...directory.corporations]
      .filter(([, name]) => name.toLowerCase().includes(wanted))
      .map(([id]) => id)
    if (registrationIds.length === 0 && corporationIds.length === 0) {
      return { ok: false, message: `No owner matched "${query.term}". Available: ${availableOwners(directory)}.` }
    }
    return { ok: true, scopes: { registrationIds, corporationIds } }
  }

  // An entry can be an id on either side (a bare integer is an EVE character
  // id OR a corporation id) or a whole name on either side, so each is tried
  // against both and counts as matched if either bites.
  const matched = query.entries.map((entry) => ({
    entry,
    registrationIds: idsForEntry(entry, directory.characters),
    corporationIds: corporationIdsForEntry(entry, directory.corporations),
  }))
  const unmatched = matched.filter((m) => m.registrationIds.length === 0 && m.corporationIds.length === 0)
  if (unmatched.length > 0) {
    return {
      ok: false,
      message: `No owner matched ${unmatched.map((m) => `"${m.entry}"`).join(', ')}. Available: ${availableOwners(directory)}.`,
    }
  }
  return {
    ok: true,
    scopes: {
      registrationIds: [...new Set(matched.flatMap((m) => m.registrationIds))],
      corporationIds: [...new Set(matched.flatMap((m) => m.corporationIds))],
    },
  }
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
