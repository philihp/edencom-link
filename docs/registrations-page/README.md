# `/registration` — one page for characters and their extract jobs

> **Update (design-system restyle):** the page now lives at
> **`/account/registrations`** — `/registration`, `/character` and `/jobs` all
> permanently redirect there, their pages deleted (the sunset phase 5 reserved
> happened with the site-wide design-system adoption; docs/design-system/).
> The header's `[refresh]` link points there and the `characters` nav item is
> gone; `/account/settings`'s grant-template panel links it.
>
> **Planned.** Nothing here is built yet. These documents are the project plan
> for combining `/character` (the character tiles) and `/jobs` (the extract-job
> matrix) into a single page at **`/registration`**, laid out per the Claude
> Design mockup **`Registrations v2.dc.html`**. They are written to be executed
> phase by phase in later sessions, possibly by a cheaper model — each phase
> names the files it touches and the invariants it must not break.

## Goal

One page that answers, per linked character: who is this character, what state
are they in (ISK, location, ship, clones, implants, job slots), and how fresh
is the data behind all of it — with the refresh machinery of `/jobs` attached
where the staleness actually is, instead of on a separate page.

## Hard constraints

1. **Functional parity, exactly.** Every capability of `/character` and `/jobs`
   exists on `/registration`, behaving identically. The parity inventories in
   phases 2 and 3 are checklists, not summaries — an implementer ticks every
   line.
2. **The old pages keep working, unchanged.** `/character` and `/jobs` stay
   live and identical in behavior until a separate, later sunset decision that
   is **out of scope for this plan**. No redirects, no nav changes to them,
   until phase 5 — and phase 5 only *adds* the new page to the nav, it removes
   nothing.
3. **Parity by construction, not by copying.** Phase 1 extracts the data
   assembly out of the two `page.tsx` files into shared modules that both the
   old page and the new page import. After that, the old pages cannot drift
   from the new one — they render the same data objects.
4. The visual layer comes from the design mockup (phase 0). Where the mockup
   and parity conflict — the mockup omits a capability the old pages have —
   parity wins and the gap is listed in the phase's notes for the user to rule
   on, rather than silently dropped.

## Naming

The route is **`/registration`** (singular, matching the `registration` table
and the "registration = one linked EVE character on an account" vocabulary —
see the id-naming note in CLAUDE.md). The design file says "Registrations";
the on-page `<h1>` copy can say whatever the mockup says.

## Phases

| Phase | Doc | What lands | Depends on |
| ----- | --- | ---------- | ---------- |
| 0 | [00-design-import.md](00-design-import.md) | The design mockup + its `_ds` bundle committed under `docs/registrations-page/design/`, and a written extraction of its structure | user action (seed the design) |
| 1 | [01-shared-data-seams.md](01-shared-data-seams.md) | `characterData.ts` / `jobsData.ts` extraction; old pages refactored onto them with **zero** behavior change | nothing — can start now |
| 2 | [02-page-shell-and-characters.md](02-page-shell-and-characters.md) | `/registration` route, page shell per the mockup, character section at full parity | 0, 1 |
| 3 | [03-jobs-parity.md](03-jobs-parity.md) | Jobs sections (characters / corporations / shared universe / recent activity), refresh buttons, poller — full parity | 1, 2 |
| 4 | [04-integration.md](04-integration.md) | The actually-combined parts: per-character freshness on the character cards, cross-links, whatever the mockup fuses | 2, 3 |
| 5 | [05-launch.md](05-launch.md) | Nav entry, docs updates, parity sign-off checklist | 2–4 |

Phases 2 and 3 are separately shippable PRs; phase 1 is its own PR (a pure
refactor, easy to review as such). Do not fold phase 1 into phase 2 — the
zero-behavior-change claim is only checkable when the refactor stands alone.

## What this plan is deliberately not

- Not a sunset plan for `/character` or `/jobs` (later project).
- Not a redesign of the refresh machinery (`dispatchRefresh`, `refresh_task`,
  heartbeats) — all reused as-is.
- Not a schema change. No migrations anywhere in this plan.
