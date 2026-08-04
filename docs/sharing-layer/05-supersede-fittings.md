# Phase 5: fold fittings into the unified model

**Status: not started.**

`character_fitting_share` works today (create/revoke UI on the fitting page,
RLS policies, `fitting_shared_with_caller()`), but it speaks the Revision 2
dialect: one row per `level` (`corporation`/`alliance`/`public`) with a dead
`token` placeholder column. This phase migrates it to the Revision 3 row
shape so every share in the product configures the same way.

## Migration

New table `character_fitting_share` columns — or, preferred, alter in place
(the name is fine, the shape isn't):

- add `corporation_ids bigint[] not null default '{}'`, `alliance_ids
bigint[] not null default '{}'`, `secret text`;
- backfill from the level rows: for each `(registration_id, fitting_id)`
  group, `level='corporation'` becomes the owner's corporation id at
  migration time appended to `corporation_ids` (resolved through
  `character_directory`), `level='alliance'` likewise into `alliance_ids`,
  `level='public'` becomes the empty-audience row; collapse the group to
  **one row** (new `unique (registration_id, fitting_id)`);
- drop `level` and the dead `token` column.

Semantics note the migration must preserve: today's `level='corporation'`
share means "whoever is _currently_ in my corp" — membership resolves live
through the owner's directory row. The Revision 3 arrays pin **specific**
corporation/alliance ids instead. Backfilling the owner's current corp id
keeps today's audiences intact at cut-over, but the meaning shifts from "my
corp, wherever I go" to "this corp". That shift is deliberate (it is what the
asset share does, and what the dialog's checkbox list expresses); call it out
in the PR description.

- Rewrite `fitting_shared_with_caller(registration_id, fitting_id)` to match
  on the arrays via `asset_share_matches_caller()`'s logic (or extract a
  shared `share_audience_matches(corporation_ids, alliance_ids, secret)` and
  have both call it — do the extraction here, retrofitting phase 1's helper
  to delegate). The widening policy on `character_fitting_over_time` is
  untouched — it already just calls the helper.
- Update the audience-read policy on the share table to the array/anon form
  from phase 1.

## UI

The fitting page swaps its three toggle buttons (`shareControls.tsx`) for the
phase-3 share dialog, parameterized by subject kind: the dialog's form is
identical, only the actions differ (`fitting/actions.ts` gains the same
save/revoke pair over the new shape; ownership proof stays "read the fit
through RLS"). Fittings gain the link-token audience for free —
`/fitting/[characterId]/[fittingId]?share=…` resolves through a fitting
variant of `resolveSignedShare` (service-role read scoped to the grantor,
same as the asset path).

## Deliverables

- Migration + `schema.sql` dual-write (table reshape, helper rewrite,
  policies); the shared `share_audience_matches()` extraction.
- Dialog reuse on the fitting page; `fitting/actions.ts` rewrite;
  `shareControls.tsx` deleted.
- `list_fittings` (MCP) needs no change — it reads through RLS.

## Verification

Existing shares keep working across the migration (corp/alliance mates still
see the fit; public still public — assert in a `test:sql` script over a
seeded copy). Dialog edits round-trip. A signed fitting link opens the fit
signed-out. `pnpm run lint && pnpm test && pnpm run build`.
