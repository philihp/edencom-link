// Turning "share it with my corp and anyone who has the link" into the
// audience columns a lens row carries.
//
// The web editor doesn't need this: its share dialog offers checkboxes built
// from the caller's own corporations and alliances, so the ids are picked, not
// typed. The MCP `create_lens` tool has the opposite problem — a model relays
// what a human said in words ("my corp", "Karmafleet", an id pasted from
// somewhere) and something has to decide which of those, if any, name an
// audience this user may actually aim at.
//
// Pure module (ramda only), so the matching and the exclusivity rules are
// unit-tested without a Supabase client — see test/lensAudience.test.ts.
import { reduce } from 'ramda'

// Relative + .ts, like the other pure modules: `pnpm test` runs Node's
// stripped-types loader, which resolves no path aliases.
import { pickOne } from './match.ts'

export type AudienceOption = { id: number; name: string }

export type OwnAudiences = { corporations: AudienceOption[]; alliances: AudienceOption[] }

export type AudienceRequest = {
  // Names or ids, as a human would say them. "my corp" / "mine" resolves when
  // there's exactly one to mean.
  corporations?: string[]
  alliances?: string[]
  // A signed URL that works for anyone holding it, signed in or not.
  link?: boolean
  // Anyone at all, no link needed.
  isPublic?: boolean
}

export type ResolvedAudience = {
  corporationIds: number[]
  allianceIds: number[]
  link: boolean
  isPublic: boolean
  // False means "saved but not shared with anyone" — the state a lens starts
  // in. It matters because the lens row IS its own share row: an empty
  // audience with sharing on would read as public.
  shared: boolean
}

export type AudienceResolution = { ok: true; audience: ResolvedAudience } | { ok: false; message: string }

// What a person says when they mean "the one I'm in" rather than naming it.
const SELF_REFERENCES = ['my corp', 'my corporation', 'mine', 'my alliance', 'ours', 'my own']

// One requested audience → one option the caller actually holds. Id, exact
// name, then unique substring come from the shared matcher; the "I only have
// one" reading of "my corp" is this caller's own fallback, and only applies
// once the matcher has found nothing (a corporation actually named "Mine"
// still wins).
const matchOne = (requested: string, options: AudienceOption[], kind: string): { id: number } | { error: string } => {
  const picked = pickOne(
    requested,
    options.map((o) => ({ id: String(o.id), name: o.name })),
    kind
  )
  if (picked.ok) return { id: Number(picked.id) }

  if (SELF_REFERENCES.includes(requested.trim().toLowerCase())) {
    if (options.length === 1) return { id: options[0].id }
    return {
      error:
        options.length === 0
          ? `You have no ${kind} to share with.`
          : `"${requested}" is ambiguous — you're in more than one ${kind}: ${options
              .map((o) => `${o.name} (${o.id})`)
              .join(', ')}. Name the one you mean.`,
    }
  }

  return { error: picked.message }
}

// The first failure wins and is carried to the end rather than thrown: a
// half-resolved audience is never useful, and the message names the one thing
// that couldn't be matched.
const matchAll = (
  requested: string[],
  options: AudienceOption[],
  kind: string
): { ids: number[] } | { error: string } =>
  reduce(
    (acc: { ids: number[] } | { error: string }, one: string) => {
      if ('error' in acc) return acc
      const matched = matchOne(one, options, kind)
      if ('error' in matched) return matched
      return { ids: acc.ids.includes(matched.id) ? acc.ids : [...acc.ids, matched.id] }
    },
    { ids: [] as number[] },
    requested
  )

// Resolve a requested audience against what the caller actually holds.
//
// Public is exclusive rather than absorbing: the web dialog silently drops the
// corporation list when public is ticked, which is fine for a checkbox someone
// is looking at, but a tool asked for both has been told two different things
// and should say so instead of quietly picking one.
export const resolveAudience = (request: AudienceRequest, own: OwnAudiences): AudienceResolution => {
  const corporations = request.corporations ?? []
  const alliances = request.alliances ?? []
  const link = request.link === true
  const isPublic = request.isPublic === true

  if (isPublic && (corporations.length > 0 || alliances.length > 0 || link)) {
    return {
      ok: false,
      message:
        "A public lens is already visible to everyone, so it can't also be narrowed to a corporation, alliance or link. Ask for one or the other.",
    }
  }

  const matchedCorporations = matchAll(corporations, own.corporations, 'corporation')
  if ('error' in matchedCorporations) return { ok: false, message: matchedCorporations.error }
  const matchedAlliances = matchAll(alliances, own.alliances, 'alliance')
  if ('error' in matchedAlliances) return { ok: false, message: matchedAlliances.error }

  const shared = isPublic || link || matchedCorporations.ids.length > 0 || matchedAlliances.ids.length > 0

  return {
    ok: true,
    audience: {
      corporationIds: matchedCorporations.ids,
      allianceIds: matchedAlliances.ids,
      link,
      isPublic,
      shared,
    },
  }
}
