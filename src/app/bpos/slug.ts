// The /bpos/[name] URL is a person's MAIN character name with its spaces
// turned into dashes — /bpos/sir-cuddles for "Sir Cuddles". Pure helpers, so
// the round trip (name → slug, slug → the SQL probe that finds it again) is
// testable without a database.
import { escapeLike } from '../../utils/escapeLike.ts'

// A character name's canonical slug. Lowercased so the URL is case-insensitive
// in practice, whitespace collapsed so a double space can't mint a second slug
// for the same pilot. EVE names carry no other punctuation worth folding —
// apostrophes and hyphens are legal in a name and survive verbatim.
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
