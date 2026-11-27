# Ledger plan, version 2: prove the cash first, then widen

Status: 🔧 stage 1 is in its 14-day soak (2026-11-21 to 2026-12-05); stage 2
is designed ([stage-2.md](stage-2.md)) and waits for gate 1. Section 10 has
the status of each stage. This plan
replaces the approach and the PR order of [design.md](design.md) (version 1,
2026-11-07). Version 1 stays as the record of the chart of accounts and the
posting ideas. Where the two differ, this file wins.

The owner asked for a new look at the whole project, and for checks at each
step that prevent a catastrophe. This file gives:

1. what was wrong with version 1,
2. the catastrophes that can occur, and the guard for each,
3. the new design, in layers,
4. the invariants (the rules that must always hold),
5. the stages, each with a dry run, a gate, a rollback and stop conditions,
6. the decisions the owner must make.

## 1. What the project is for

`/market` shows turnover from two feeds and matches payments by hand. The
owner wants the accounting a real company does: a P&L with fees, a group
view across characters and corporations, and, if the data permits, margin.

The wallet journal is the only complete record of ISK. ESI serves 30 days of
it. A row we did not pull in that window is lost for all time. That fact
shapes the plan: **the first product of this project is a proof that the
journal is complete**, and an alarm when it is not.

## 2. What was wrong with version 1

| # | Problem in version 1 | Result |
| - | :------------------- | :----- |
| 1 | PR 1 stored an entry and two or three postings for each journal row of all history, and backfilled them in production. | A large write load on a database that stopped from Disk IO exhaustion on 2026-11-15 and 2026-11-17. |
| 2 | The cash ledger was stored. But a journal row always gives the same two lines. A stored copy must be kept in sync, and a change to one `ref_type` rule needs a rebuild of all history. | Storage and sync risk for no gain. |
| 3 | Posting was incremental ("rows newer than the last posted id") and FIFO lots depend on order. Old rows arrive late: a jEveAssets import, a new character, contract items fetched later, an extract gap filled. | The result depends on arrival order. A rerun does not give the same lots. |
| 4 | The `ref_type` table stated CCP behaviour that nobody measured: what the `tax` column means, the sign of escrow entries, what a buy-order fill posts. | Wrong postings that balance. A balanced entry can still be wrong. |
| 5 | Reconciliation was a list of warnings after the fact. No check stopped a stage. | Wrong figures can ship. |
| 6 | `intercompany` was stored on the entry. But one corporation can have directors on two accounts, and the group is different for each viewer. | Wrong consolidated statements for one of them. |
| 7 | Inventory lots were kept per entity. Items move between alts with no price and often no record. | Most lots would be estimates. The margin would look exact and not be. |
| 8 | PR 5 moved `/market` to the ledger and removed the direct reads. No parallel run, no flag. | A regression on a page that works, with no fast way back. |
| 9 | No test plan for RLS. The ledger shows corporation finances. | Risk of a leak. |
| 10 | The owner had to choose FIFO or weighted average before any data showed how much stock has a known cost. | A decision without evidence. |

## 3. Catastrophes and their guards

A "catastrophe" here is an event we cannot undo, or one that stops the site.

| ID | Catastrophe | Guard |
| -- | :---------- | :---- |
| C1 | **Source data lost or changed.** The five wallet tables hold history that ESI no longer has. | The ledger never writes to a source table. A CI check refuses a ledger migration or module that names a source table in `insert`, `update`, `delete`, `alter`, `drop` or `truncate`. No new foreign key points into a source table. Before stage 1, the owner confirms that Supabase backups are on, and the lab copy (stage 0) is a second copy of the sources. |
| C2 | **The database stops again** (Disk IO). | No backfill of postings at all for the cash ledger (it is a view). Each stored table is small. Each job has a row budget and stops when it reaches it. Heavy analysis runs on the lab copy only. Each read is bounded by a date window and an owner. Each new query gets an `explain` in the PR. New indexes on the journal tables are not permitted without a measured need and a size estimate. One daily single-step job, no fan-out. |
| C3 | **Wrong numbers shown as fact.** | A figure is shown as "proven" only for a span where the balance chain holds (I-2, I-3). All other spans show "not proven" with the reason. Unknown `ref_type` goes to Suspense and the page shows its share. Each stage has a parallel run against a figure we already trust. |
| C4 | **A leak of finances.** | Views are `security_invoker`. No `SECURITY DEFINER`. No `anon` grant. Each new table, view and function has a `test/sql` file that proves an outsider reads zero rows and a member reads only its own. The group view is computed for the caller at read time. |
| C5 | **Migrations wedged.** | The rules in CLAUDE.md: timestamp from the clock, no renames, one migration per PR. Each migration has a rollback SQL file, tested in `test/sql` (the pattern of `rollback-structure-share.sql`). |
| C6 | **Extract jobs broken by the ledger.** | The extract jobs are not changed in stages 1 to 3, with one exception (the corporation wallet balance pull, stage 1, one more request in a job that exists). The ledger has its own job. A failure of that job cannot fail an extract. |
| C7 | **`/market` regression.** | `/market` keeps its code path. New figures appear on a new page first. A change to `/market` is behind a flag, and the old path stays until the owner removes it. |
| C8 | **The wrong database is reset.** `schema.sql` is a full reset. | Each lab script refuses to run unless the database host is `localhost` or `127.0.0.1`. The check is the first line and has a test. |
| C9 | **A decision that cannot be changed later** (cost method). | Stored results are written as numbered runs with their parameters. A different method is a new run, not a migration (section 4, layer 4). |
| C10 | **Lost journal rows that nobody sees.** This is a risk today, with or without a ledger. | Stage 1 finds a break in the chain no later than one day after it occurs. That leaves about 29 days to repair a token or a role before ESI drops the rows. |

## 4. The design, in layers

Each layer is useful alone. Each layer starts only when the gate of the
layer below it is passed.

### Layer 0 — Evidence: is the journal complete?

A **wallet** is one character, or one division of one corporation.

Each journal row has `amount` and `balance` (the wallet balance after the
row). Thus two adjacent rows of one wallet must satisfy
`balance(n) = balance(n-1) + amount(n)`. Where this fails, rows are missing
between them. A **segment** is a longest run of rows where the rule holds.
In a segment the journal is proven complete, to the cent.

- `ledger_wallet_segment`: one row for each segment (wallet, first and last
  `entry_id`, first and last date, opening and closing balance, row count).
  A healthy wallet has one segment. The table has a few rows per wallet.
- `ledger_check`: one row for each daily check of each wallet (segments,
  breaks, newest row, balance compare, pass or fail, the reason).
- **Wallet balance compare.** `character_wallet` already holds balance
  snapshots. The balance of the journal at the time of a snapshot must agree
  with the snapshot. For corporations no balance is extracted today. Stage 1
  adds one request to `corp-wallet-journal`
  (`GET /corporations/{id}/wallets/`, same scope and roles) and a small
  `corp_wallet` table. This is the only new ESI pull in the plan.
- **Alarm.** A new break, or a wallet whose newest journal pull is older
  than 7 days, is reported to the owner (the Chancellor page first; a push
  notification later, per docs/ntfy-notifications.md).

### Layer 1 — The cash ledger: a view, not a table

Each journal row gives two lines: the cash account of the wallet with
`+amount`, and one other account with `−amount`. The lines sum to zero by
construction. Nothing is stored and nothing is backfilled.

- `ledger_account`: the chart of accounts (seeded, about thirty rows; start
  from the list in design.md).
- `ledger_ref_type`: the classification, **as data**. One row for each
  `ref_type`: the account when ISK comes in, the account when ISK goes out,
  a `transfer` flag (the row moves ISK between two parties and can be
  internal to a group), a `verified` flag (true only when stage 0 measured
  the behaviour), a note. A `ref_type` with no row goes to
  `9000 Suspense`.
- `ledger_cash_line`: the view (`security_invoker`) that joins the two
  journal tables to the map and gives the two lines for each row.
- `ledger_cash_statement(from, to)`: sums the view by account for the
  caller's entities, in a date window. The cash balance at a date is read
  from the `balance` column, not from a sum of all history. So no read
  walks the whole journal.

A change to a rule is one `update` of one map row. All history changes at
the next read, and the change is reversed by the opposite `update`.

A rollup table per day is **not** in the plan. Add one only if stage 2
measures a statement read above 500 ms.

The `tax` column is **not** posted as a third leg until stage 0 shows what
it means. Until then it is carried as an attribute of the row.

### Layer 2 — The group, at read time

The group of a caller is: the characters of the account, and the
corporations one of them directs (the proof in
`src/app/structure/directors.ts`). It is computed for the caller on each
read. It is not stored on a ledger row.

A `transfer` row whose other party is in the group is **internal**. The
consolidated statement leaves it out. A statement for one entity keeps it.

Check (I-7): an internal transfer must appear in the two wallets with
opposite amounts. A transfer with only one side is listed, and the
consolidated figure for that day is marked "not proven".

### Layer 3 — Links: what a row was for

The sub-ledgers explain a journal row. They do not post anything.

- journal ↔ market transaction, through `journal_ref_id`,
- journal ↔ contract and journal ↔ industry job, through `context_id` and
  `context_id_type`,
- fees ↔ the trade they belong to (rule decided from stage 0 data).

Result: `ledger_sales(from, to)`, a sale with its item, its counterparty,
its fees and its net ISK. This is what `/market` needs for "net of fees". It
needs no inventory.

### Layer 4 — Entries the journal does not have (stored, in runs)

Some events move no ISK: a zero-price contract (a sale on credit), cost of
goods, opening stock, a write-off. These need stored entries.

- `ledger_run`: one row for each build (id, kind, parameters, rule version,
  the newest source ids it read, row counts, a checksum, the check results,
  status `building`, `checked`, `active`, `retired`).
- `ledger_entry` and `ledger_line`: each row carries its `run_id`. A
  deferred constraint trigger refuses a commit where the lines of an entry
  do not sum to zero.
- Readers see only the `active` run. A rebuild writes a new run, runs the
  checks, and only then changes the `active` pointer, in one statement. To
  go back, set the pointer to the run before. Old runs are deleted later, in
  small batches.

A build is a **full replay in event-time order** for one group. It is not
incremental. Thus late data cannot change the result by its arrival order:
it marks the group dirty, and the next build replays it.

The full books are the union of the cash view (layer 1) and the active run.

### Layer 5 — Inventory and cost of goods (only after a go decision)

- Inventory is pooled **for the group**, not per entity. A move between two
  alts is then no event at all.
- The cost method (FIFO or moving average) is a parameter of the run. Stage
  4 runs the two methods on the lab copy and shows the difference.
- A sale with no known cost is marked "estimate". A margin is shown for an
  item only when the replayed units agree with the asset snapshot within a
  limit (I-13). Below the limit the page shows turnover only.

## 5. The invariants

"Where" says what enforces the rule. A rule with "gate" stops a stage.

| ID | Rule | Where |
| -- | :--- | :---- |
| I-1 | **Sources are not touched.** The row counts and newest ids of the five wallet tables are the same before and after each ledger operation. | CI check on code and migrations; the daily job records the counts; gate. |
| I-2 | **Chain.** In a segment, `balance(n) = balance(n-1) + amount(n)`, exactly. | Segment builder; `test/sql`; daily check. |
| I-3 | **Cash proof.** In a segment, the sum of the cash lines equals closing balance minus opening balance. | Daily check; gate of stage 2. |
| I-4 | **Balanced.** The lines of each entry sum to zero. | View: by construction, with a test. Stored: constraint trigger. |
| I-5 | **Complete classification.** The view has exactly two lines for each journal row. The Suspense share of ISK is reported. | `test/sql`; daily check; gate (Suspense below 1% of ISK moved for a "complete" label). |
| I-6 | **Deterministic.** Two builds from the same sources give the same checksum. | Stage 5 and 6 gate; lab test. |
| I-7 | **Internal transfers come in pairs** that sum to zero in the group. | Daily check; marks the day. |
| I-8 | **Links agree.** For a linked trade, the journal amount equals quantity × unit price (rule fixed after stage 0). | Daily check; gate of stage 3. |
| I-9 | **Wallet compare.** The journal balance at the time of a balance snapshot equals the snapshot (with the tolerance stage 0 measures for ESI cache times). | Daily check; alarm. |
| I-10 | **Run isolation.** A reader sees one run. A run becomes `active` only when all its checks pass. | Function that sets the pointer; `test/sql`. |
| I-11 | **RLS.** An outsider reads zero rows from each ledger object. A corporation member who is not a director gets no group view of that corporation. | `test/sql` for each object; gate of each stage. |
| I-12 | **Accounting equation.** Assets = liabilities + equity for a group at any date. | Follows from I-4; a test proves it on the lab copy. |
| I-13 | **Units.** Replayed units of a type agree with the asset snapshot within the limit, or the type shows no margin. | Stage 6 daily check. |
| I-14 | **Write budget.** A job run writes no more than its row budget, then stops and reports. | In the job; a test. |

## 6. The stage protocol

Each stage follows the same nine steps. A stage is not done until step 9.

1. **Design note.** A short section added to this file: what ships, the
   assumptions, the invariants it adds.
2. **Lab first.** All SQL and all jobs run on the lab copy (section 7,
   stage 0) before production. The lab run records row counts, bytes
   written and run time. These become the budget for production.
3. **Tests.** Pure seams under `node:test`. SQL rules under `test/sql`,
   which includes the RLS test and the rollback test.
4. **One PR, one migration**, rebased on `origin/main`, opened once, not
   polled.
5. **Dark.** The Vercel flag `ledger` is off (read as
   `src/app/mail/corpSpam.ts` reads its flag: a flag that cannot be read is
   off). Pages are also limited to the owner's account until stage 7.
6. **Dry run in production.** The job runs with `--dry-run`: it reads,
   computes and prints the counts and the check results. It writes nothing.
   The output is compared with the lab output.
7. **Live, with a budget.** The job writes, with the row budget from step 2
   plus 20%. Above the budget it stops.
8. **Soak.** The daily check runs for the soak time of the stage. The
   database IO figures of the Supabase dashboard are compared with the week
   before.
9. **Gate review.** The owner sees a short report: each invariant, pass or
   fail, the numbers. The owner says "go" for the next stage.

**Stop conditions for all stages.** Stop, turn the flag off, and report
when: I-1 fails; the database shows IO pressure or a query above its time
limit; a check that passed in the lab fails in production; an RLS test
fails; the production database is down or was restarted in the last 24
hours.

**Rollback for all stages.** (a) Turn the flag off: all pages and reads go
away at once. (b) Remove the cron entry: all writes stop. (c) Run the
rollback SQL of the stage: the ledger objects go away. No step touches a
source table, so no rollback can lose history.

## 7. The stages

### Stage 0 — Measure. No schema change, no production write.

**Purpose:** replace the assumptions with measurements, and make the lab.

1. **Make the lab copy.** A local Postgres (the Supabase local stack on the
   owner's computer). A script copies the five wallet tables,
   `character_wallet`, the contract tables and the industry job tables of
   the owner's account from production. It reads through PostgREST with
   the service key, in pages of 1,000 rows by primary key, with a pause
   between pages, at a quiet hour. It needs the owner's OK each time, as
   the tax rebate report did. It refuses to write to a host that is not
   local (C8). The copy is also a second backup of the sources (C1).
2. **Run the census on the lab.** One SQL file, `docs/ledger/census.sql`.
   It answers these questions:

   | ID | Question | Why it matters |
   | -- | :------- | :------------- |
   | H1 | Does `entry_id` order equal time order in one wallet? | The chain rule needs an order. |
   | H2 | Does the chain rule hold for each `ref_type`? Are `amount` or `balance` ever null? | Layer 0 depends on it. |
   | H3 | What does `tax` mean? Is the balance change `amount`, or `amount − tax`? | A third leg or an attribute. |
   | H4 | Does a transfer between two of our characters have the same `entry_id` on the two sides? And character to corporation? | The pair check I-7. |
   | H5 | Do the two sides of one market trade have the same `transaction_id`? The transaction tables use `transaction_id` alone as the key. If yes, a trade between two of our entities keeps only one side today. | A possible loss in the source tables, to repair before layer 3. |
   | H6 | For a `market_transaction` row, does the amount equal quantity × unit price? What does a buy-order fill from escrow post? | The link rule I-8 and the escrow account. |
   | H7 | Which `context_id_type` values occur for each `ref_type`? | The links of layer 3. |
   | H8 | Do the rows imported from jEveAssets have balances that chain? | How far back "proven" can go. |
   | H9 | How well do `character_wallet` snapshots agree with the journal balance? What time tolerance is needed? | The compare I-9. |
   | H10 | Which `ref_type` values occur, with which signs, how many rows, how much ISK? | The seed of `ledger_ref_type`; the Suspense share. |
   | H11 | How many rows and bytes does each source table have, and how many segments does each wallet have today? | Budgets; the size of the gaps we already have. |

3. **Write `docs/ledger/measurements.md`**: totals and counts only, no
   names. Each assumption of this plan is marked confirmed or refuted.

**Gate 0.** The owner reads the measurements. Stop and redesign if the
chain rule (H2) holds for less than 99% of adjacent rows in wallets that
were pulled without a pause: the control of the whole plan would be false.

### Stage 1 — Evidence layer in production (layer 0)

**Ships:** `ledger_wallet_segment`, `ledger_check`, `corp_wallet` and the
one added request in `corp-wallet-journal`; the daily job `ledger-check`
(one single-step workflow, at a quiet minute); a Chancellor-only page
`/ledger/health` that lists each wallet with its proven spans, its breaks
and its last compare.

**Checks:** I-1, I-2, I-9, I-11, I-14. The segment table in production must
equal the one the lab computed for the same rows.

**Budget:** a few rows per wallet on the first run, then about one row per
wallet per day in `ledger_check`.

**Soak:** 14 days. **Gate 1:** no new break without a known cause (a role
lost, a token expired); IO figures not changed; rollback SQL tested in the
lab.

**Value alone:** the alarm of C10. This stage is worth it even if the
project stops here.

### Stage 2 — Cash ledger and group view (layers 1 and 2)

**Ships:** `ledger_account`, `ledger_ref_type` (seeded from the stage 0
census; `verified` only where measured), `ledger_cash_line`,
`ledger_cash_statement()`, the group function, and `/ledger` (P&L by month,
per entity or group, the Suspense list, the "proven" and "not proven"
labels). Flag off; owner only.

**Checks:** I-3, I-4, I-5, I-7, I-11. No stored rows, so no budget.

**Parallel run:** for the same window, the market sales revenue on
`/ledger` must equal the sum of market sales on `/market`. Each difference
is listed and explained before the gate. The facility tax income must equal
`/structure/revenue` for the same window.

**Soak:** 14 days. **Gate 2:** I-3 passes for each proven segment; Suspense
below 1% of ISK moved, or each remaining `ref_type` has a decision; the
parallel runs agree; statement read time measured (rollup needed or not).

### Stage 3 — Links and sales net of fees (layer 3)

**Ships:** the link view, `ledger_sales()`, and on `/market`, behind the
flag, the fees and net ISK of each trade. The old `/market` path is not
removed. If H5 is true, a separate PR first repairs the key of the
transaction tables with an additive migration (no row is deleted).

**Checks:** I-8, I-11. **Parallel run:** turnover on `/market` with the flag
on equals turnover with the flag off. **Soak:** 7 days. **Gate 3:** link
coverage and agreement reported; the owner accepts the fee rule.

### Stage 4 — Decision gate for inventory (lab only)

**No production change.** A prototype replays the owner's history on the
lab copy with FIFO and with moving average, pooled for the group. The
report shows: what share of sales value has a known cost; the unit
agreement with the asset snapshots by type (I-13); the difference between
the two methods; the run time and the rows a run would store.

**Gate 4 (owner):** go or stop. If less than about 60% of sales value has a
known cost, the recommendation is to stop: show sales net of fees, and take
margin from build-cost estimates (the Planner), which do not pretend to be
books.

### Stage 5 — Stored entries and receivables (layer 4)

**Ships:** `ledger_run`, `ledger_entry`, `ledger_line`, the balance
trigger, the build job (full replay per group, dry run, row budget), and
the receivable for a zero-price contract (design.md, "a sale on credit").

**Checks:** I-4, I-6, I-10, I-11, I-12, I-14. **Parallel run:** the
receivable rule and the present `payments.ts` match run side by side for 14
days; each contract where they differ is listed. `payments.ts` stays until
the owner removes it. **Gate 5:** two builds give one checksum; the pointer
change and the change back are shown in production.

### Stage 6 — Inventory and cost of goods (layer 5), only after "go"

**Ships:** opening stock, purchases, sales with cost, industry jobs, with
the method the owner chose, as a new run kind. Margin on `/ledger` and,
behind the flag, on `/market`, each with the "estimate" mark where it
applies.

**Checks:** I-6, I-12, I-13, I-14. **Soak:** 14 days. **Gate 6:** unit
agreement above the limit for the types that carry most of the sales value.

### Stage 7 — Open to all accounts; MCP and GraphQL reads

The flag goes on for all. Before that: the RLS tests run with two test
accounts and a shared corporation on a Supabase preview branch
(`test:branch`); the build job gets a budget per group and one group at a
time; the read tools are read-only on the bearer client.

## 8. Decisions for the owner

Now, before stage 0:

1. **OK to make the lab copy** from production (read-only, paged, at a
   quiet hour, on the owner's computer). Recommended: yes. Without it, each
   check must run on production.
2. **Confirm the backups** of the Supabase project (daily backups or
   point-in-time recovery) before stage 1.
3. **OK to add the corporation wallet balance pull** in stage 1 (one more
   ESI request per corporation per run). Recommended: yes. It is the
   independent control for corporation wallets.

Later, with data: the Suspense rules (gate 2), the fee rule (gate 3), go or
stop for inventory and the cost method (gate 4). The four decisions of
design.md are not needed now. The group rule (director proof) is kept.

## 9. What this plan does not do

- It does not change or delete a source row, in any stage.
- It does not backfill in production before the same run passed on the lab.
- It does not replace `/market`. It adds to it, behind a flag.
- It does not value assets at market, and it does not cover corporation
  market orders, PI, LP or fuel as inventory (as in design.md).

## 10. Stage status

### Stage 0 — design note (step 1 of the protocol)

**Ships (one PR, no migration, no production write):**

- The lab: `src/ledger/labCopy.ts` (the read-only copy, as CSV files),
  `src/ledger/lab.ts` (load and census), `docs/ledger/lab/schema.sql`. How to
  use it: [lab.md](lab.md).
- The census: `docs/ledger/census_views.sql` (H1 to H11 as temporary views)
  and `docs/ledger/census.sql` (the report).
- The chain proof in TypeScript: `src/ledger/chain.ts` (segments and
  breaks, exact to the cent with `src/ledger/money.ts`). Stage 1's job uses
  it. Its tests use the same cases as the census test, so the two agree.
- Guard C8: `src/ledger/labGuard.ts`. Each lab command refuses a database
  that is not on this computer.
- Guard C1: `.github/scripts/check-ledger-sources.mjs`, a CI step in
  `test.yml`. It refuses a ledger file that writes to one of the five
  source tables.

**Tests:** `test/ledgerChain.test.ts`, `test/ledgerLab.test.ts`,
`test/checkLedgerSources.test.ts` (`node:test`); `test/sql/ledger_census.sql`
(each census view on rows with known answers).

**Assumptions:**

- A wallet's chain order is entry id order. H1 measures if that is also
  time order.
- A row that came from the jEveAssets import is one first seen more than 31
  days after its date (ESI keeps 30 days). H8 uses this.
- H5 is measured from the journal alone: a `market_transaction` row names
  its transaction in `context_id`. If that transaction is stored for another
  of our wallets, the two sides share one `transaction_id`, and the key
  `transaction_id` alone kept only one side.
- H9 tolerance: a snapshot agrees if a journal row within one hour has that
  balance before or after it.

**Invariants added:** none in production. The census test proves the
segment rule (I-2) on known rows.

**Steps 5 to 8 do not apply** to stage 0: nothing is deployed.

| Step | State |
| :--- | :---- |
| Tools and tests | ✅ built, PR open |
| Lab copy | ✅ 2026-11-17, owner's OK; 2,136 pages, slowest 1.03 s, no error |
| Census run | ✅ 2026-11-17, 7 minutes on the lab |
| `measurements.md` | ✅ written |
| Gate 0 | ✅ passed; one-cent rule decided 2026-11-19 (a 0.01 ISK step rounds to zero). Stage 1 waits for the owner's "go". |

**Owner decisions recorded 2026-11-17:** the lab copy may run at any time;
Supabase runs a daily backup at about 07:30; the corporation wallet balance
pull is approved for stage 1.

### Stage 1 — status

Design note: [stage-1.md](stage-1.md). Shipped in #1312, #1313 and #1318.

| Step | State |
| :--- | :---- |
| 1–4 Design, lab, tests, PR | ✅ merged 2026-11-20 |
| 5 Dark | ✅ the flag `ledger` is not created, so `/ledger/health` is a 404 |
| 6 Dry run in production | ✅ 2026-11-20, 192 wallets |
| 7 Live, with a budget | ✅ 2026-11-21, 1,020 rows of a 3,000 budget |
| 8 Soak | 🔧 14 days from the cron merge (2026-11-21 19:03 UTC), to 2026-12-05 |
| 9 Gate 1 | waits for the soak |

Soak log (from the job's log line; counts only):

| Run (UTC) | Wallets checked | Failing | Rows read | Rows written | Time |
| :-------- | --------------: | ------: | --------: | -----------: | :--- |
| 2026-11-22 09:43 | 192 of 348 | 1 (known: one journal last pulled 2026-11-11) | 4,807 | 264 | about 1 min |
| 2026-11-23 09:43 | 192 of 348 | 1 (the same) | 4,148 | 268 | about 1 min |
| 2026-11-24 09:43 | 192 of 348 | 2 (a second journal, last pulled 2026-11-16, passed the 7-day limit) | 4,288 | 264 | about 1 min |
| 2026-11-25 09:43 | 192 of 348 | 2 (the same two) | 4,984 | 268 | about 1 min |
| 2026-11-26 09:43 | 194 of 348 | 2 (the same two) | 3,565 | 250 | about 1 min |

No new break in five runs. The two failures are stale pulls (rule 5), each a
character whose `character-wallet-journal` pull stopped; the cause (token or
grant) is for the owner to check on `/account/registrations`.

### Stage 2 — status

Design note: [stage-2.md](stage-2.md), written 2026-11-22. Lab and tests done
2026-11-22.

| Step | State |
| :--- | :---- |
| 1–3 Design, lab, tests | ✅ 2026-11-22 |
| 4 PR, migration | ✅ #1328 and #1329 merged 2026-11-26 by the owner, before gate 1 (the owner's decision). Migration applied 2026-11-26 21:07 UTC |
| 5 Dark | ✅ the flag `ledger` is not created; `/ledger` is a 404 |
| 6 Check in production | waits for the flag. Stage 2 has no job, so the check is one read of `/ledger` by the owner: the read time, the Suspense share and the two parallel runs against the lab figures. The lab read used a sequential scan of the journal; production holds all accounts, so the plan and the time must be seen there before the soak starts |
| 7 Live | does not apply (no stored rows) |
| 8 Soak | 14 days from step 6 |
| 9 Gate 2 | waits |
