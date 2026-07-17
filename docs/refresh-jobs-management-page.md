# Plan: refresh-jobs management page (Universal / Corp / Character)

Restructure the existing "Refresh ESI" page (`/character/refresh`) into a
job-management page organized around **who a job runs for**, with three
sections in this order:

1. **Universal** — read-only. Whole-account / whole-universe jobs. Just show
   when each last ran; no refresh buttons.
2. **Corp** — one row per corporation, columns for **corp wallet**,
   **structures**, and **industry jobs**, each showing freshness + a refresh
   button, plus a **Token** column naming the character whose director-role
   token the last pull ran under.
3. **Character** — the existing per-character × per-job freshness matrix,
   unchanged in spirit.

This is a reorganization of what `src/app/character/refresh/page.tsx` already
renders (it currently has *Characters / Corporations / Account-wide* sections),
not a greenfield page. Reuse its `Cell`, `RefreshButton`, `RefreshPoller`,
`latest_heartbeats()` read, and `refresh_task` overlay wholesale — only the
section groupings and the corp column set change.

## Why this is mostly a re-layout, not new plumbing

Everything the three sections need already exists:

- **`latest_heartbeats()`** (`schema.sql`) returns one row per `(job,
  owner_key)` scoped to the caller by the `heartbeat` RLS policy:
  `user_id is null OR user_id = auth.uid() OR corporation_id in (caller's
  corps)`. Three consequences that make all three sections work today:
  - **Corp jobs** already write a per-corp heartbeat carrying the token
    character (`forEachCorporation` in `src/jobs/lib.js` attributes
    `corporation_id` + `character_id` + `user_id`). Verified: `corp-structures`,
    `corp-wallet-journal`, `corp-wallet-transactions`, `corp-industry-jobs`,
    `corp-assets`, `corp-blueprints` all go through `forEachCorporation`. So the
    "which director token" column is available for **every** corp job, including
    the two (`corp-structures`, `corp-wallet-journal`) that aren't refreshable
    on demand yet.
  - **Account batch jobs** (`character-affiliations`, `universe-names`) write
    `user_id`-attributed heartbeats → visible to their owner.
  - **Whole-universe cron jobs** (`industry-systems`, `universe-structures`,
    `sde-mirror`) run under the service role with `user_id IS NULL` → the
    `user_id is null` clause makes their last-run readable by **any**
    authenticated user. This is what lets the Universal section show them
    read-only without any per-user attribution.
- **The matrix/cell machinery** — `Cell`, `Freshness`/`freshnessLevel`,
  `RefreshButton`, `RefreshPoller`, the `refresh_task` overlay keyed by cell,
  and the `corpRunsAs` reduction that already computes the token character — is
  all in `page.tsx` today. The corp `corpRunsAs`/`owned`/`representative`
  logic (whose token last ran, falling back to a corpmate note or the
  registration order) is exactly what the Token column needs; keep it verbatim.

The only **new** behavior is making `corp-structures` and `corp-wallet-journal`
refreshable on demand (they're cron-only today). Everything else is markup and
grouping.

## Section-by-section

### 1. Universal (read-only)

Jobs that aren't scoped to one of the user's characters or corps. Render a
two-column table (**Job**, **Last run**) with a plain `<Freshness at={…} />`
and **no** `RefreshButton`.

| Row label | Job name | Heartbeat owner | Notes |
|---|---|---|---|
| affiliations | `character-affiliations` | `user_id` (own) | account batch |
| universe names | `universe-names` | `user_id` (own) | account batch |
| universe structures | `universe-structures` | `user_id IS NULL` (global) | whole-universe cron |
| industry indexes | `industry-systems` | `user_id IS NULL` (global) | whole-universe cron |
| SDE mirror | `sde-mirror` | `user_id IS NULL` (global) | nightly workflow |

Read straight from `latest_heartbeats()`: account rows land in the existing
`accountBeats` map (keyed by job, `character_id`/`corporation_id` null); the
global cron rows land there too (same null owner_key). So the Universal section
is just:

```tsx
const UNIVERSAL_JOBS = [
  ['character-affiliations', 'affiliations'],
  ['universe-names', 'universe names'],
  ['universe-structures', 'universe structures'],
  ['industry-systems', 'industry indexes'],
  ['sde-mirror', 'SDE mirror'],
] as const
// row: <td>{label}</td><td><Freshness at={accountBeats.get(job)} /></td>
```

This intentionally **drops the Chancellor-gated refresh button** for
`industry-systems` from this page — Universal is view-only. If we want to keep
that on-demand kick, leave it where it is (the current Account-wide section /
`refreshCell`'s `CHANCELLOR_ACCOUNT_JOBS` gate) or add it back as a
Chancellor-only button in this row; see Open decisions. `universe-structures`
and `sde-mirror` are shown here for the first time (they were on no matrix
before) — purely informational.

> Freshness thresholds (`src/app/freshness.ts`) are tuned for the 6-hourly
> extracts: green <15 min, yellow <75 min, red beyond. Daily and nightly
> universal jobs will read **red** almost always. That's misleading here, so
> Universal should render the raw "N ago" timestamp text **without** the
> red/yellow/green dot, or use a relaxed threshold. Recommend: reuse
> `Freshness` for the "N minutes/hours ago" string but suppress the color
> (a `plain` prop, or just render `<time>` from the same relative formatter).
> Decide in Open decisions.

### 2. Corp (freshness + Token, refreshable)

One row per corporation the user has a registered character in. Columns:

| Corporation | Token | wallet | structures | industry |
|---|---|---|---|---|

- **Corporation** — `<Name>` resolved via `universe_name` (as today).
- **Token** — the `corpRunsAs` character (whose token the newest corp
  heartbeat ran under): own character `<CharacterName>`, else the
  `"a corpmate's"` note, else the `representative` (registration order). Copy
  the existing block from `page.tsx` unchanged.
- **wallet / structures / industry** — `<Cell>` with the corp's freshness from
  `corpBeats.get(\`${job}:${corporationId}\`)` and the per-cell `refresh_task`
  overlay from `taskByCell`.

Job mapping for the three columns:

| Column | Job | On-demand today? |
|---|---|---|
| wallet | `corp-wallet-journal` *(recommended)* or `corp-wallet-transactions` | journal: **no** (cron-only); transactions: yes |
| structures | `corp-structures` | **no** (cron-only) |
| industry | `corp-industry-jobs` | yes |

**"corp wallet" = which job?** The request says "corp wallet." Two candidates:
- `corp-wallet-journal` — the transaction *log* (ISK in/out, tax, fees); backs
  `/structure/revenue`. Cron-only today.
- `corp-wallet-transactions` — market buys/sells; already unioned into the
  market page and already the on-demand-refreshable one shown in today's corp
  table.

Recommend **`corp-wallet-journal`** for the "wallet" column: journal +
structures + industry are the three director-token corp pulls, and journal is
the truer "wallet" (balance movements), matching the "director token" framing.
(If we'd rather not touch dispatch plumbing, use `corp-wallet-transactions`,
which is already refreshable — see Open decisions.)

**Making `corp-structures` and `corp-wallet-journal` refreshable** (needed
because the request wants a refresh-style table, and these two are cron-only):

1. **Export their scope.** `src/jobs/corpStructures.js` and
   `src/jobs/corpWalletJournal.js` currently declare `const SCOPE = …`; change
   to `export const SCOPE = …` (the other corp jobs already export it —
   `corpWalletTransactions`, `corpIndustryJobs`, `corpAssets`).
   - `corp-structures` scope: `esi-corporations.read_structures.v1`
   - `corp-wallet-journal` scope: `esi-wallet.read_corporation_wallets.v1`
     (same as transactions).
2. **Add them to `PER_CORPORATION_JOBS`** in
   `src/app/character/dispatchRefresh.ts`:
   ```ts
   { job: 'corp-structures',      loadScope: async () => (await import('@/jobs/corpStructures.js')).SCOPE },
   { job: 'corp-wallet-journal',  loadScope: async () => (await import('@/jobs/corpWalletJournal.js')).SCOPE },
   ```
   This routes their on-demand kicks through the same one-message-per-corp
   fan-out (carrying every scoped character so `forEachCorporation` can fall
   back through director tokens), and `refreshCell` already accepts anything in
   `PER_CORPORATION_JOB_NAMES`, so the per-cell button "just works."
   - **Caveat — the auto-dispatch side effect.** Adding a job to
     `PER_CORPORATION_JOBS` also makes `dispatchRefresh` fan it out **on every
     character add**. For `corp-structures`/`corp-wallet-journal` that's
     whole-corp work the current design deliberately keeps off the add path
     (see the long comment in `dispatchRefresh.ts`). To keep the on-demand
     button **without** the add-time fan-out, split the list: introduce
     `PER_CORPORATION_ON_DEMAND_JOBS` (all five) used by `refreshCell`'s
     allow-check + `dispatchSingleJob`, but leave `dispatchRefresh`'s add-time
     loop on the original three (`corp-assets`, `corp-industry-jobs`,
     `corp-wallet-transactions`). `dispatchSingleJob` already handles any corp
     job generically via its `PER_CORPORATION_JOBS.find` — point that lookup at
     the combined list. **Recommended**, so a character add doesn't start
     kicking structures/journal pulls it never used to.
3. The queue consumer (`/api/queue/jobs`) already dispatches to
   `runCorpStructures`/`runCorpWalletJournal` by job name — no change.
4. **`corp-wallet-journal` duration.** It's the one still exposed to the 60s
   function limit for large corps (runs per division, sequential). On demand
   it's one corp at a time, so fine; no change beyond noting it.

If we instead keep the "wallet" column on `corp-wallet-transactions`, only
`corp-structures` needs the export + list addition; the wallet column is
already on-demand.

### 3. Character (unchanged)

Keep the existing per-character matrix verbatim — `CHARACTER_JOBS` columns
(assets, blueprints, orders, transactions, industry, dens, status), one row per
registration, `Cell` with freshness + refresh button + task overlay. Only its
position (now last) and heading ("Character") change.

## Files touched

| File | Change |
|---|---|
| `src/app/character/refresh/page.tsx` | Re-group into Universal / Corp / Character; add `UNIVERSAL_JOBS`; change corp `CORP_JOBS` columns to wallet/structures/industry; drop the Chancellor `industry-systems` refresh row (moves read-only into Universal — or keep, per Open decisions). Reuse all existing reductions. |
| `src/app/character/dispatchRefresh.ts` | Add `corp-structures` + `corp-wallet-journal` to the on-demand corp-job list; recommend splitting add-time vs on-demand lists so a character add doesn't fan these out. |
| `src/jobs/corpStructures.js` | `export const SCOPE` (was `const`). |
| `src/jobs/corpWalletJournal.js` | `export const SCOPE` (was `const`) — only if "wallet" = journal. |
| `src/app/character/refresh/actions.ts` | If the add-time/on-demand lists are split, point `refreshCell`'s allow-check at the combined on-demand list. |
| `src/app/character/refresh/refresh.module.css` | Optional: a `plain`/color-suppressed Freshness variant for Universal's daily/nightly rows. |

No schema migration required — heartbeats, RLS, and `latest_heartbeats()` all
already cover these jobs. This stays a UI + dispatch-wiring change.

## Open decisions

1. **Replace vs. new route.** Recommend **replacing** the current
   `/character/refresh` layout in place (the header already links there:
   `src/app/layout/header.tsx` → `/character/refresh`), rather than adding a
   second page. If a distinct URL is wanted (e.g. `/character/jobs`), add it and
   redirect the old one in `next.config.mjs`. The plan above assumes in-place.
2. **"corp wallet" = journal or transactions.** Recommend `corp-wallet-journal`
   (director-token wallet log; requires the export + on-demand-list change).
   Alternative: `corp-wallet-transactions` (zero dispatch changes, but it's the
   market-trade feed, already shown on the market page).
3. **Universal freshness coloring.** Daily/nightly jobs read red under the
   6-hour thresholds. Recommend showing the "N ago" text without the
   green/yellow/red dot for Universal rows. Alternative: leave the dot (expect
   red) or add per-job relaxed thresholds.
4. **`industry-systems` on demand.** Universal is read-only, which removes the
   Chancellor kick button that lives on this page today. Recommend keeping it
   read-only here and, if the manual kick still matters, leaving a
   Chancellor-only button on this one row (reuse `refreshCell`'s existing
   `CHANCELLOR_ACCOUNT_JOBS` gate and defense-in-depth `isChancellor` check).
5. **Add-time fan-out.** Strongly recommend the split-list approach in Corp §
   step 2 so adding a character doesn't newly trigger whole-corp structures /
   wallet-journal pulls.

## Verification (no test runner; gates are lint + build + manual)

- `pnpm run lint` and `pnpm run build`.
- Manually: open the page signed in with (a) no characters, (b) a character in
  a corp whose structures/wallet you can pull, (c) a character in a corp where
  the token is a corpmate's on another account (Token column shows "a
  corpmate's"). Confirm each corp column's refresh button dispatches a
  `refresh_task`, the `RefreshPoller` flips the cell pending → running → the
  fresh dot, and the Universal rows show last-run text with no button.
- Confirm a **character add** does *not* enqueue `corp-structures` /
  `corp-wallet-journal` (watch the `dispatchRefresh` log line / `refresh_task`
  rows) if the split-list recommendation is taken.

## Explicitly out of scope

- Any change to the extract jobs' logic, schedules, or tables.
- Corp `assets`/`blueprints`/`transactions` columns (not in the requested corp
  set — structures/wallet/industry only).
- A per-job "notify me" hook (see `docs/ntfy-notifications.md`).
