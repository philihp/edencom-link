# Phase 3 — jobs sections at parity

> **Shipped** (with phase 4, one PR). The jobs side landed as the design's
> grant matrix rather than the /jobs tables: one cell per (character, job)
> fusing grant state and last run, columns derived from
> `jobsInSection('character')` (nine, not the mockup's five), corporations as
> a second matrix with per-cell runs-as, and the shared-universe + recent
> activity tables below. The checklist held; deviations and deferrals are
> recorded at the end of 04-integration.md.

Adds the extract-jobs half of `/registration`, over `fetchJobsOverview` from
phase 1, presented per the phase-0 extraction. Whatever the mockup's visual
treatment, the information and actions are exactly `/jobs`'s.

## Reuse vs. restyle

`nextRun.tsx` (client countdown), `refreshButton.tsx` (`RefreshButton`,
`RefreshAllButton` — server-action dispatchers over
`src/app/jobs/actions.ts`), and `poller.tsx` (`RefreshPoller`) are wired
machinery: **reuse them as imports.** The table/row presentation (`Cell`,
`Status`, `EntityJobTable`) may be reimplemented to match the mockup — but if
the mockup's presentation is table-shaped anyway, import those too and style
via the new module CSS. Never fork `rows.ts`/`registry.ts`/`schedule.ts`.

## Parity checklist (from `/jobs` today)

- [ ] **Characters section** — one row per per-character job
      (`jobsInSection('character')`), each showing: label + `<code>` job
      name; entity count with "N lagging" note; collapsible per-character
      breakdown; **Last run = oldest** character's run (freshness dot);
      row status via `rowStatus`; next run countdown or `overdue` (title text
      preserved) via `isOverdue`/`nextRunFor`
- [ ] Per-character cells: running/queued/failed/skipped states win over the
      freshness dot; refresh button appears only when kickable, not in
      flight, not `skipped`, and (dot off green or last run failed)
- [ ] **Refresh all** button inside the breakdown when kickable === 'always'
      and >1 character
- [ ] **Corporations section** (rendered only when the account has corps):
      per-corp rows with the **Runs as** column — one corp shows the token's
      character name or "a corpmate's"; several show "per corp" collapsed;
      breakdown rows name each corp's runs-as; `skipped` renders
      "— not a director" and never claims Runs as; refresh dispatches against
      the representative registration
- [ ] **Shared universe section**: plain relative ages (no freshness dot —
      the nightly-cadence rationale in the page copy), status, next-run/
      overdue; kick gated to Chancellors for `kickable === 'chancellor'`
      (`industry-systems`), server-side re-check untouched in `refreshCell`
- [ ] **Recent activity**: caller's `refresh_task` rows from the last 24h,
      newest first, batch-grouped (enqueued time only on `firstOfBatch`),
      job, character, status (incl. `abandoned` via `isAbandoned`), error
      text, duration seconds
- [ ] `RefreshPoller` re-polling while `anyActive`; page stays
      `force-dynamic`
- [ ] The zero-registrations state points at adding a character —
      on this page that target is the page's own Add Character button, not
      `/character` (the one deliberate copy change; note it in the PR)
- [ ] Status vocabulary/glyphs preserved (`STATUS_LABEL`) unless the mockup
      restyles them, in which case every state still has a distinct rendering
      including `skipped`, `abandoned`, `queued` vs `pending`
- [ ] Explanatory paragraph copy: keep the load-bearing explanations
      (oldest-of-your-characters, runs-as, not-a-director, UTC schedules,
      nothing-starts-on-page-open) in some form the mockup accommodates —
      tooltips/details are fine, deletion is not

## Verification

`lint` + `build` + `pnpm test` (rows/schedule tests must still pass
untouched). Manual: kick a refresh on `/registration`, watch it poll to done;
confirm the same task shows on old `/jobs` too (same `refresh_task` table) —
that cross-visibility is expected and fine.
