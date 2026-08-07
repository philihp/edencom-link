// Picking one thing out of a list from what a person called it.
//
// The MCP lens tools take names, not identifiers: a model relays "Karmafleet",
// "my fuel lens", an id pasted from somewhere. Two places need to turn that
// into exactly one row — which corporation an audience names (./audience.ts)
// and which lens an edit is aimed at (./lensRef.ts) — and getting the same
// answer from both matters more than either one's specifics, so the algorithm
// lives here once.
//
// Ambiguity is always an error, never a guess. These calls decide who can see
// someone's data or which saved query gets overwritten; picking the first of
// two plausible matches is the wrong failure.
//
// Pure module (no imports), unit-tested via its two callers' tests.

export type Named = { id: string; name: string }

export type Picked = { ok: true; id: string } | { ok: false; message: string }

const normalize = (value: string): string => value.trim().toLowerCase()

// Tried in descending order of certainty: the id verbatim, then an exact name,
// then a name containing the query. An exact hit wins over a substring even
// when the substring would be ambiguous — "KarmaFleet" is exactly one thing
// despite also being part of "Karmafleet University".
export const pickOne = (query: string, candidates: Named[], kind: string): Picked => {
  const wanted = normalize(query)
  if (wanted === '') return { ok: false, message: `An empty ${kind} name can't be matched.` }

  const listed = candidates.map((c) => `${c.name} (${c.id})`).join(', ') || `none — you have no ${kind} to choose from`

  const byId = candidates.find((c) => normalize(c.id) === wanted)
  if (byId) return { ok: true, id: byId.id }

  const exact = candidates.filter((c) => normalize(c.name) === wanted)
  if (exact.length === 1) return { ok: true, id: exact[0].id }
  if (exact.length > 1) {
    return {
      ok: false,
      message: `"${query}" is the name of more than one ${kind}. Use the id instead. Yours: ${listed}.`,
    }
  }

  const partial = candidates.filter((c) => normalize(c.name).includes(wanted))
  if (partial.length === 1) return { ok: true, id: partial[0].id }
  if (partial.length > 1) {
    return {
      ok: false,
      message: `"${query}" matches more than one ${kind}: ${partial.map((c) => c.name).join(', ')}. Say which one.`,
    }
  }

  return { ok: false, message: `"${query}" is not one of your ${kind}s. Yours: ${listed}.` }
}
