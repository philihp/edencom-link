# Phase 5 — Industry jobs and market orders

## Goal

Two list screens over fields the schema already has:
`industryJobs(owner, owners, includeDelivered)` and
`marketOrders(owner, owners)`. The industry screen answers "what finishes
soon, and where"; the market screen answers "what do I have on the market, and
is it moving". No server change is needed for v1 of either.

## Industry

- `mobile/app/(tabs)/industry.tsx` — jobs sorted by `endDate` ascending,
  sections "Ready", "Ending today", "Later", "Delivered" (the last behind a
  toggle, `includeDelivered: true`).
- Each row: activity (manufacturing, reaction, ME/TE research, copy,
  invention — the names from `ACTIVITY_NAMES`, `src/app/industry/jobFields.ts`),
  product type icon and name, runs, installer, facility name and system, a
  countdown to `endDate`.
- A pure `sectionJobs(jobs, now)` in `mobile/src/screens/industry/`, tested:
  the section boundaries, the terminal statuses that go to "Delivered", the
  sort.
- Job slot usage per character comes from phase 3's `Character.status.jobSlots`
  and is shown as a header strip.

## Market

- `mobile/app/(tabs)/market.tsx` — open orders, buy and sell as two sections,
  each row: type icon and name, price, remaining/total volume, location,
  issued and expiry.
- Totals per section (sell value, buy escrow) with `Isk`.
- A pure `sectionOrders(orders)` with a test.

## Done when

- Both screens show the same rows and counts as `/industry` and `/market` on
  the web for the same account (paste both in the PR).
- Countdown and expiry use the phone's clock against the row's UTC stamps and
  agree with the web within a minute.

## Risks and notes

- **Delivered jobs stay current.** The SCD-2 rule keeps a job we saw finish as
  `is_current` (CLAUDE.md, SCD Type 2). `includeDelivered: false` is the
  default and matches the web.
- **Corp market orders are not extracted.** `marketOrders` is character-owned
  only and refuses an owner filter naming only corporations. The app does not
  offer that filter.
- **Cost indices and structures** are not in this phase. They need
  `industryCostIndices` and `structures` fields that exist as MCP tools but
  not in GraphQL; add them as a later phase with the same "add to the schema
  first" rule.
