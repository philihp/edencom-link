# Phase 5 — launch (additive only)

The sunset of `/character` and `/jobs` is explicitly **not** this phase, this
plan, or this decision. This phase makes `/registration` findable without
taking anything away.

1. **Nav.** Add `registration` to the signed-in nav in
   `src/app/layout/header.tsx`. Do **not** remove `characters`; do not change
   the header's `[refresh]` link target (`/jobs`) yet. Where exactly it slots
   in the nav order is the user's call — ask, or default to replacing nothing
   and sitting beside `characters`.
2. **Docs.** Update `docs/jobs-page.md` and this folder's README with a
   pointer note ("superseded-by-candidate: /registration; old pages remain
   live"). Update the CLAUDE.md routes list to include `/registration`.
3. **Parity sign-off.** Run the phase 2 + phase 3 checklists top to bottom on
   production data (multi-character account, an account with corps, a
   Chancellor account, a zero-registration account) and record the result in
   the PR description. Any unticked line blocks this phase.
4. **Hand the user the sunset decision** as a short list of what a future
   sunset PR would touch, discovered during this project — at minimum:
   redirects for `/character` and `/jobs` (permanent, in the app or
   `next.config.mjs` alongside the existing ones), the header `[refresh]`
   link, the `href="/character"` / `href="/jobs"` references in
   `src/app/structure/page.tsx`, `structure/[structureId]/page.tsx`,
   `asset/assetsTable.tsx`, `account/invite/page.tsx`,
   `settings/grants/page.tsx`, `page.tsx` (front page CTA),
   `fitting/fittingMatrix.tsx`, the `revalidatePath('/character')` in
   `account/settings/actions.ts`, and the `?from=characters` grants detour in
   `character/actions.ts`. Record it here; act on none of it.
