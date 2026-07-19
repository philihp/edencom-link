# Stage 01 — Privacy policy & terms of service pages

**PR size:** tiny · **Depends on:** nothing · **Blocks:** stage 02 (the
Discord app registration form asks for these URLs)

## Goal

Two static pages, `/privacy` and `/terms`, so the Discord application can be
registered with real Privacy Policy / Terms of Service URLs. Independently
useful: the site stores EVE character data and OAuth tokens and currently
says nothing about it.

## Deliverables

- `src/app/privacy/page.tsx` — server component, static content, standard
  `metadata` export for the title. No client JS.
- `src/app/terms/page.tsx` — same shape.
- Links to both from the footer (`src/app/layout/` — Footer component).
- No schema changes, no env vars, no new dependencies.

## Content scope (what the privacy page must actually cover)

Write it plainly and truthfully for what the app does today plus what this
project adds. At minimum:

- **What we collect:** email + password (Supabase Auth); EVE character
  identity and OAuth refresh tokens (EVE SSO); the game data the extract
  jobs pull via ESI on the user's behalf (assets, wallet, industry jobs,
  clones, mercenary dens, …) and its history (the SCD-2 tables keep old
  versions); and — once stage 03 lands — Discord guild/channel ids and the
  Discord user id that ran the link command.
- **What we do with it:** show it back to the account that linked it;
  corp-scoped sharing where the user opts in (den shares, corp tables);
  public share pages only where explicitly enabled (`/corpses`, ship share
  tokens). No selling, no third-party analytics.
- **Third parties data transits:** Supabase (storage), Vercel (hosting),
  CCP/ESI (source), Discord (once notifications post to a channel — note
  that messages posted to a Discord channel are governed by Discord's own
  terms and visible to that channel's members).
- **Removal:** how to unlink a character / delete an account, and that
  revoking the EVE SSO grant at CCP's side kills our token.
- **Contact:** an email or GitHub issues link.

The terms page can be short: personal-use tool, no warranty, not affiliated
with CCP (include CCP's required copyright notice for EVE IP — the standard
"EVE Online and the EVE logo are the registered trademarks of CCP hf." text
already used by community sites), Discord's brand likewise.

This is a hobby project, not a law firm's client — keep the pages honest and
readable rather than boilerplate-maximal. If the wording matters to you,
have a human review it; that review is outside this PR's scope.

## Milestone / acceptance

- `pnpm run lint` + `pnpm run build` pass.
- `/privacy` and `/terms` render on production, reachable from the footer.
- The URLs are stable enough to paste into the Discord developer portal in
  stage 02 (don't plan to move them later).

## Out of scope

- Cookie banners / consent tooling (no third-party analytics exist).
- A data-export endpoint (candidate follow-up if anyone ever asks).
