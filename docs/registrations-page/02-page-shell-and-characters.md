# Phase 2 — `/registration` shell + character section at parity

Adds `src/app/registration/page.tsx` (+ `registration.module.css`, and a
`loading.tsx` mirroring `/jobs`'s skeleton pattern) rendering the page shell
from the phase-0 extraction and the character section over
`fetchCharacterOverviews` from phase 1. Jobs sections come in phase 3 — the
shell should leave their slots visibly stubbed only if the mockup demands the
full frame; otherwise ship the character section alone.

## Route mechanics

- Server component, like both parents. Auth gate: `establishedUser`; redirect
  target `'/'` (what `/character` does — the register CTA lives there).
- It will need `export const dynamic = 'force-dynamic'` once the poller lands
  in phase 3; adding it now is fine and harmless.
- No nav link yet (phase 5). The page is reachable by URL for anyone signed
  in — same posture `/jobs` had while it was being built. No dark-launch flag
  needed unless the user asks; if they do, `user_settings.flags` +
  `KNOWN_FLAGS` in `src/flags.ts` is the mechanism (import from
  `flagCatalog.ts` in anything clientside — see the server-timing note in
  CLAUDE.md).

## Character-section parity checklist (from `/character` today)

Every line below must hold on `/registration`, whatever the mockup's layout:

- [ ] One card/tile per `registration` row, in the query's order
- [ ] Portrait from `images.evetech.net/characters/{character_id}/portrait?size=128`;
      an empty `aria-hidden` placeholder when `character_id` is null
- [ ] Name
- [ ] Job-slot bubbles (`JobSlots` markup): three rows
      manufacturing/research/reactions; filled = running, ready = delivered-
      awaiting, empty = free; row widens past `max` rather than clipping
      (never hide a job); `title` tooltip text preserved; rendered **only**
      when the character has skill rows (`slotMax.has(id)` — no guessing)
- [ ] ISK: latest wallet balance via `formatBisk`, `—` when absent
- [ ] Location: current system name, `—` when absent
- [ ] Ship: link to `/ship/{itemId}`, label `"<name> (<type>)"` collapsing to
      the type name when they match; `—` when absent
- [ ] Clone systems: uniq, sorted, system *paths* (region-qualified, from
      `fetchSystemPaths`), rendered only when non-empty
- [ ] Implants: resolved type names, only when non-empty
- [ ] The "Limited access selected" warning (`role="alert"`) when the account
      has enabled no optional ESI scopes, linking `/settings/grants`
- [ ] The Supabase error dump block on query failure (status/statusText/
      code/message/pretty JSON) — keep it; it has debugged real incidents
- [ ] **Add Character** button posting to the `register` server action
      (`src/app/character/actions.ts`) — reused, not copied; the action's
      grants-detour and anonymous-session behavior are untouched

## Styling

Implement the mockup's card design with the app's existing tokens per the
phase-0 token mapping. House rules that override the mockup where they
conflict: one typeface per heading (globals.css note); character portraits
are not `TypeIcon` (different image path, fine as a plain `<img>`, as today).

## Verification

`lint` + `build`; manual side-by-side against `/character` with a
multi-character account, ticking the checklist. `/character` itself must be
byte-identical to before this PR (it shares phase 1's modules; this phase
must not touch them except additively).
