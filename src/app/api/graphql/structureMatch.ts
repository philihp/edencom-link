// Pure name matching for the `location:`/`locations:` filters, for the shape a
// structure name actually has in game: "TK-DLH - CUDDLES T2 Composite
// Reactions". Nobody types that. They type "TKD Reactions", and a link that
// only accepts the location id (or the whole name, byte for byte) is a link
// they have to build from an id they had to look up somewhere else.
//
// The rule, in two halves, matching how the name itself is built:
//
//   FIRST TOKEN → THE SOLAR SYSTEM. Compared against system names with the
//   punctuation removed from both sides, so "TKD", "TK-D" and "tkdlh" are the
//   same question. It is a PREFIX, not a substring: "TK-DLH" starts with
//   "TKD". Two systems sharing the prefix is a refusal, never a guess — a
//   filter that quietly picks one of two systems is worse than one that says
//   it doesn't know. A prefix matching NOTHING is shortened a character at a
//   time (down to MIN_SYSTEM_PREFIX) until exactly one system answers, which
//   is what quietly corrects a typo in the tail: "TK-DLS" → "TKDL" → TK-DLH.
//
//   THE REST → WHICH STRUCTURE IN IT. Split on spaces, and the structure
//   matching the most of those tokens wins. That makes the full name work
//   ("TK-DLH - CUDDLES T2 Composite Reactions" scores every token), a suffix
//   work ("TKD Reactions"), and a couple of words scattered through the name
//   work too ("TKD Reactions T2" beats the Reprocessing tower next door). A
//   tie is a refusal for the same reason an ambiguous system is.
//
// No I/O — the candidate rows are fetched by locationSearch.ts. Tested in
// test/graphqlStructureMatch.test.ts.
import { descend, head, sortWith, splitEvery } from 'ramda'

export type NamedRef = { id: string; name: string }

// Both sides of every comparison. EVE writes system names with a hyphen
// ("TK-DLH") and structure names with spaces and punctuation around them;
// neither is something a person retypes reliably, and none of it carries
// meaning we'd want to match on.
export const normalizeIdent = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, '')

// Split on whitespace, dropping anything that normalizes away — the lone "-"
// in "TK-DLH - CUDDLES" is punctuation, not a token to score.
export const tokenize = (term: string): string[] => term.split(/\s+/).filter((t) => normalizeIdent(t) !== '')

// Below this, a prefix stops being a name and starts being a letter. It bounds
// the typo correction (how far the first token may be shortened) and the
// candidate query (how much of it reaches the database).
export const MIN_SYSTEM_PREFIX = 3

// The `ilike` pattern that fetches the system candidates: the first
// MIN_SYSTEM_PREFIX characters with a `%` after each, anchored at the start.
// "TKD" → "T%K%D%", which is every system whose name begins with those three
// characters in order however it punctuates them ("TK-DLH", "TKD-2N") — a
// superset of the real answer, narrowed exactly by pickSystem below. Deliberately
// a superset: the database can't see through the hyphen, so JS does.
export const systemPrefixPattern = (token: string): string =>
  splitEvery(1, normalizeIdent(token).slice(0, MIN_SYSTEM_PREFIX))
    .map((c) => `${c}%`)
    .join('')

export type SystemPick =
  | { kind: 'match'; ref: NamedRef }
  // Several systems answer to the prefix — say so rather than picking one.
  | { kind: 'ambiguous'; names: string[] }
  | { kind: 'none' }

const startingWith = (candidates: readonly NamedRef[], prefix: string): NamedRef[] =>
  candidates.filter((c) => normalizeIdent(c.name).startsWith(prefix))

// The first token against the systems the pattern turned up. Shortening on a
// miss is the whole typo story: every shorter prefix is still a prefix of the
// same names, so the candidate set never needs re-fetching.
export const pickSystem = (token: string, candidates: readonly NamedRef[]): SystemPick => {
  const wanted = normalizeIdent(token)
  const at = (length: number): SystemPick => {
    if (length < MIN_SYSTEM_PREFIX || length > wanted.length) return { kind: 'none' }
    const hits = startingWith(candidates, wanted.slice(0, length))
    if (hits.length === 1) return { kind: 'match', ref: hits[0] }
    if (hits.length > 1) return { kind: 'ambiguous', names: hits.map((h) => h.name) }
    return at(length - 1)
  }
  return at(wanted.length)
}

// How many of the query's tokens this name accounts for. A token counts once,
// against any word of the name it starts — a prefix so "Compo" finds
// "Composite", counted once so repeating a word can't inflate a score.
export const scoreName = (tokens: readonly string[], name: string): number => {
  const words = tokenize(name).map(normalizeIdent)
  return tokens.filter((t) => {
    const wanted = normalizeIdent(t)
    return words.some((w) => w.startsWith(wanted))
  }).length
}

export type StructurePick =
  | { kind: 'match'; ref: NamedRef }
  // Two structures account for the same tokens; the caller has to say more.
  | { kind: 'ambiguous'; names: string[] }
  | { kind: 'none' }

// The best-scoring structure in the system, or a refusal. Ordered by score and
// then by name so the tie check reads the same rows in the same order every
// run — an ambiguity that resolved differently per request would be worse than
// either answer.
export const pickStructure = (tokens: readonly string[], candidates: readonly NamedRef[]): StructurePick => {
  if (tokens.length === 0 || candidates.length === 0) return { kind: 'none' }
  const scored = candidates.map((ref) => ({ ref, score: scoreName(tokens, ref.name) })).filter((s) => s.score > 0)
  const ranked = sortWith<{ ref: NamedRef; score: number }>(
    [descend((s) => s.score), (a, b) => a.ref.name.localeCompare(b.ref.name)],
    scored
  )
  const best = head(ranked)
  if (best === undefined) return { kind: 'none' }
  const tied = ranked.filter((s) => s.score === best.score)
  if (tied.length > 1) return { kind: 'ambiguous', names: tied.map((s) => s.ref.name) }
  return { kind: 'match', ref: best.ref }
}

// The whole term, given what the two halves turned up: the structure when the
// tokens after the system name single one out, and the system itself when
// there are none (a bare "TKD" is a question about the system).
export const pickLocation = (
  rest: readonly string[],
  system: NamedRef,
  structures: readonly NamedRef[]
): NamedRef | null => {
  if (rest.length === 0) return system
  const picked = pickStructure(rest, structures)
  return picked.kind === 'match' ? picked.ref : null
}
