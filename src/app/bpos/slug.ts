// The /bpos/[name] URL is a person's MAIN character name, or a CORPORATION's
// name, with its spaces turned into dashes — /bpos/sir-cuddles for "Sir
// Cuddles". Pure helpers, so the round trip (name → slug, slug → the SQL probe
// that finds it again) is testable without a database.
import { escapeLike } from '../../utils/escapeLike.ts'

// An EVE name's canonical slug. Lowercased so the URL is case-insensitive in
// practice, whitespace collapsed so a double space can't mint a second slug for
// the same subject. EVE names carry no other punctuation worth folding —
// apostrophes and hyphens are legal in both character and corporation names and
// survive verbatim. Named for characters because they came first; corporation
// names slug by exactly the same rules.
export const characterSlug = (name: string): string => name.trim().replace(/\s+/g, '-').toLowerCase()

// The slug isn't reversible on its own — a dash in the URL could have been a
// space or a literal dash in the name — so the lookup goes the other way: a
// LIKE pattern where every dash is `_`, Postgres's single-character wildcard.
// That over-matches by design (it also finds "Sir-Cuddles"), and the caller
// narrows the result by comparing characterSlug() exactly. Escaping runs FIRST
// so a `%` or `_` typed into the URL is matched literally rather than widening
// the probe; the dash substitution then only touches dashes the escape left.
export const slugLikePattern = (slug: string): string => escapeLike(slug).replace(/-/g, '_')

// A character is "main" if it's flagged so, and otherwise the account's oldest
// — the same fallback the header and /asset use to label an account. Ordering
// here rather than in SQL because the page already holds every registration on
// the account for the blueprint scope.
export type MainCandidate = { name: string; is_main?: boolean | null; created_at?: string | null }

export const pickMain = <T extends MainCandidate>(registrations: readonly T[]): T | null =>
  [...registrations].sort(
    (a, b) =>
      Number(Boolean(b.is_main)) - Number(Boolean(a.is_main)) || (a.created_at ?? '').localeCompare(b.created_at ?? '')
  )[0] ?? null

// The corporation half of the same narrowing step the account resolver does by
// hand: the `_`-wildcard probe over-matches by design, so the rows it returns
// are compared by exact slug here. Rows are deduplicated by id (a probe can
// return the same corporation twice only if the directory has, but the page
// must not be at the mercy of that), and an ambiguous slug — two DIFFERENT
// corporations folding to one — resolves to nothing rather than a coin flip.
// EVE corporation names are unique, so ambiguity means only that two names
// differ solely by case or whitespace.
export type CorporationCandidate = { corporation_id: number | string; name: string | null }

export const pickCorporation = (
  rows: readonly CorporationCandidate[],
  slug: string
): { corporationId: number; name: string } | null => {
  const matches = new Map<number, { corporationId: number; name: string }>()
  rows.forEach((row) => {
    if (row.name == null || characterSlug(row.name) !== slug) return
    matches.set(Number(row.corporation_id), { corporationId: Number(row.corporation_id), name: row.name })
  })
  return matches.size === 1 ? [...matches.values()][0] : null
}
