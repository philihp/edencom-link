// Pure argument handling for the MCP list_assets tool (see tools.ts): parsing
// the three id lists it takes, and sorting the owner list into the two owner
// scopes the underlying functions are split across. No I/O, so it is unit
// tested (test/assetFilterQuery.test.ts) — the query itself lives in
// character_asset_filter()/corp_asset_filter().

// An id list long enough to be a mistake rather than a query: the arrays travel
// into an `= any(...)` and every extra id widens the subtree walk behind the
// location filter. Same spirit as MAX_TYPES on the fuzzy item search.
export const MAX_IDS = 500

export type IdList = { ok: true; ids: string[] } | { ok: false; message: string }

// Ids arrive as numbers or strings, because EVE item and structure ids run past
// what a JSON number survives intact in some clients. They are kept as decimal
// strings all the way into the query: Postgres parses them as bigint, and no
// rounding can happen on the way there.
export const parseIdList = (values: Array<number | string> | undefined, label: string): IdList => {
  if (values == null) return { ok: true, ids: [] }
  const cleaned = values.map((v) => (typeof v === 'number' ? String(v) : v.trim())).filter((v) => v !== '')
  const bad = cleaned.filter((v) => !/^\d+$/.test(v))
  if (bad.length > 0) {
    return { ok: false, message: `${label} must be whole numeric ids; couldn't read: ${bad.slice(0, 5).join(', ')}.` }
  }
  const ids = [...new Set(cleaned.map((v) => v.replace(/^0+(?=\d)/, '')))]
  if (ids.length > MAX_IDS) {
    return { ok: false, message: `${label} has ${ids.length} ids — at most ${MAX_IDS} can be filtered on at once.` }
  }
  return { ok: true, ids }
}

// The owners a caller can name. Characters are addressable by either id they
// have — the registration uuid the asset rows are keyed on, or the EVE numeric
// character id, which is what anyone reading the game (or another tool's
// output) actually has to hand.
export type OwnerDirectory = {
  registrations: Array<{ registrationId: string; characterId: string; name: string }>
  corporations: Array<{ corporationId: string; name: string }>
}

export type OwnerSplit =
  { ok: true; registrationIds: string[]; corporationIds: string[]; names: string[] } | { ok: false; message: string }

// Sort a mixed owner list into the character and corporation scopes. An id the
// caller can't see is refused rather than silently dropped: an unmatched owner
// would otherwise read as "you own none of that", which is a different answer.
export const splitOwnerIds = (values: Array<number | string> | undefined, directory: OwnerDirectory): OwnerSplit => {
  const wanted = (values ?? []).map((v) => String(v).trim()).filter((v) => v !== '')
  if (wanted.length === 0) return { ok: true, registrationIds: [], corporationIds: [], names: [] }

  const byRegistration = new Map(directory.registrations.map((r) => [r.registrationId.toLowerCase(), r]))
  const byCharacter = new Map(directory.registrations.map((r) => [r.characterId, r]))
  const byCorporation = new Map(directory.corporations.map((c) => [c.corporationId, c]))

  const registrationIds = new Set<string>()
  const corporationIds = new Set<string>()
  const names: string[] = []
  const unknown: string[] = []

  wanted.forEach((value) => {
    const character = byRegistration.get(value.toLowerCase()) ?? byCharacter.get(value)
    const corporation = byCorporation.get(value)
    if (character) {
      registrationIds.add(character.registrationId)
      names.push(character.name)
    } else if (corporation) {
      corporationIds.add(corporation.corporationId)
      names.push(corporation.name)
    } else {
      unknown.push(value)
    }
  })

  if (unknown.length > 0) {
    const available = [
      ...directory.registrations.map((r) => `${r.name} (character ${r.characterId})`),
      ...directory.corporations.map((c) => `${c.name} (corporation ${c.corporationId})`),
    ].sort((a, b) => a.localeCompare(b))
    return {
      ok: false,
      message: `Not among the owners you can see: ${unknown.join(', ')}. Available: ${available.join('; ')}.`,
    }
  }
  return {
    ok: true,
    registrationIds: [...registrationIds],
    corporationIds: [...corporationIds],
    names: [...new Set(names)],
  }
}

// Which of the two owner-scoped functions still need to run. With no owner
// filter both do; naming only characters (or only corps) makes the other side's
// query pointless, since it could not return a row that passes the filter.
export const scopesToQuery = (split: {
  registrationIds: string[]
  corporationIds: string[]
}): { character: boolean; corp: boolean } => {
  const named = split.registrationIds.length > 0 || split.corporationIds.length > 0
  return {
    character: !named || split.registrationIds.length > 0,
    corp: !named || split.corporationIds.length > 0,
  }
}
