# Phase 4 — the actually-combined parts

> **Shipped** (with phase 3, one PR). The fusion went further than the
> candidates below — the design's whole point turned out to be the grant
> matrix: per-(character, job) cells carrying grant state (on / missing /
> extra / off), the editable request-template row, re-auth detection
> ("grants trail the template"), and the four refresh granularities (cell,
> column sweep, row tail, refresh-all). New seams: `registration/matrix.ts`
> (pure, tested), `matrixData.ts` (token scopes via a service client scoped
> to the caller's own registration ids — token grants stop at service_role
> by design), `registration/actions.ts` (row/full dispatch through
> `dispatchRefresh`, template toggling into `user_settings.enabled_scopes`),
> `matrixButtons.tsx`. Registry entries now carry their jobs' ESI scopes.
>
> **Deliberate deviations & deferrals** (the user rules on each):
>
> - **remove** (per-row, in the mockup): not implemented. `registration`
>   grants authenticated only select + update(is_main) — deleting a
>   registration means a service-role action or a migration, and the cascade
>   wipes the character's extract history. Needs a product ruling first.
> - The mobile **bottom sheet** for scope sweeps is a plain `<details>`
>   disclosure shown at narrow widths, not a modal sheet.
> - The mockup's lowercase-heading voice was not adopted (extraction §4 —
>   house case conventions kept).
> - Freshness dots became the same scale as text colour on cell timestamps
>   (extraction gap 7): quiet when fresh, warn when aging, danger when stale.
> - The `/character` state fields (ISK, location, ship, clones, implants)
>   live in a per-row `details` disclosure — the extraction's "expandable
>   row" resolution; slot bubbles stay visible.
> - Nav stays untouched — phase 5 as planned.

Phases 2–3 could, at worst, ship two pages stacked under one URL. This phase
delivers the reason for merging: the connections between a character and the
jobs that feed their data. Exact scope comes from the phase-0 extraction —
build what the mockup fuses, and only that. Candidates, in likely order:

1. **Per-character freshness on the character card.** Each card shows how
   fresh *that character's* data is — derivable from `characterEntities`
   (phase 1's `JobsOverview`): the oldest `lastRunAt` across the
   per-character jobs for that registration id, rendered with the existing
   `Freshness` component. If the mockup has a per-card refresh control, it
   dispatches `dispatchRefresh` for that one registration (the per-character
   equivalent of Refresh all — `src/app/jobs/actions.ts` may need a thin new
   server action wrapping the existing dispatch path; add it beside the
   current ones, do not modify them).
2. **Job breakdown rows link back to cards** (anchor per registration id) and
   vice versa, if the mockup indicates it.
3. **One data pass.** `page.tsx` calls `fetchCharacterOverviews` and
   `fetchJobsOverview` in `Promise.all`. If profiling (Server-Timing spans
   arrive free — docs/server-timing.md) shows redundant queries — both fetch
   `registration` — de-duplicate by letting the page fetch registrations once
   and pass them in as an optional parameter to both. Optional-parameter,
   defaulting to self-fetch, so the old pages' call sites don't change.

Rules: no schema changes; no new RPCs unless a fold over already-fetched rows
genuinely can't express it; anything speculative the mockup doesn't show is
out of scope.

## Verification

`lint`/`build`; the phase 2 and 3 checklists still fully tick (integration
must not regress parity).
