// The pure rules behind the /registration grant matrix: how a job column's
// scopes, one character's granted token scopes and the account's request
// template collapse into the four cell states of the design (grant and job in
// one cell — docs/registrations-page/00a-design-extraction.md §1), plus the
// derived headlines the page puts around the grid. No I/O and no React, so the
// arithmetic that decides "why does this job never run" is testable on its own
// (test/registrationMatrix.test.ts).

// The four base states of a cell's grant icon:
//   on      — requested by the template and granted: the job runs
//   missing — requested but not granted: the job NEVER runs, and the red ✕ is
//             why ("never — no grant")
//   extra   — granted but no longer in the template: still refreshes; a later
//             re-auth would drop it
//   off     — neither requested nor granted: nothing to run, nothing to ask
export type GrantState = 'on' | 'missing' | 'extra' | 'off'

// A multi-scope column (character-status fronts six live-state endpoints) is
// granted when ANY of its scopes is — forEachCharacterAnyScope runs whichever
// endpoints the token carries, so one grant is enough for the job to exist.
// Requested follows the same rule: a template asking for any of the six is
// asking for a status pull.
export const columnGrant = (
  scopes: readonly string[],
  granted: ReadonlySet<string>,
  template: ReadonlySet<string>
): GrantState => {
  const has = scopes.some((scope) => granted.has(scope))
  const wants = scopes.some((scope) => template.has(scope))
  if (has) return wants ? 'on' : 'extra'
  return wants ? 'missing' : 'off'
}

// A cell in one of these states has a job that can actually run; the refresh
// triggers only render where this is true (a cell without a grant has nothing
// to kick — the design's "no refresh trigger" rule).
export const grantAllowsRun = (state: GrantState): boolean => state === 'on' || state === 'extra'

// The template row's checkbox for one column. 'some' is a template that asks
// for part of a multi-scope column — rendered as a mixed mark; toggling from
// there completes the set rather than clearing it.
export type TemplateCheck = 'all' | 'some' | 'none'

export const templateCheck = (scopes: readonly string[], template: ReadonlySet<string>): TemplateCheck => {
  const wanted = scopes.filter((scope) => template.has(scope)).length
  if (wanted === 0) return 'none'
  return wanted === scopes.length ? 'all' : 'some'
}

// Scopes the template asks for that this character's token doesn't carry —
// non-empty means the character's grants trail the template and a re-auth
// round trip through EVE SSO would catch them up. Compared over the whole
// template, not only the scopes the matrix draws columns for: a re-auth
// re-requests everything, so everything missing counts.
export const trailingScopes = (template: ReadonlySet<string>, granted: ReadonlySet<string>): string[] =>
  [...template].filter((scope) => !granted.has(scope))

// The legend's warn summary: how many cells across the whole matrix sit in the
// 'missing' state — jobs that will never run for want of a grant.
export const blockedCellCount = (cells: readonly GrantState[]): number =>
  cells.filter((state) => state === 'missing').length

// The header's "next scheduled sweep" is the soonest next fire across the
// given jobs' crons — one countdown for the page, where /jobs had one per row.
// (The per-column next runs still live in each column header's title.)
export const soonestNextRun = (nexts: readonly (Date | null)[]): Date | null =>
  nexts.reduce<Date | null>(
    (soonest, next) => (next !== null && (soonest === null || next < soonest) ? next : soonest),
    null
  )
