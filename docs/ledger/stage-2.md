# Ledger stage 2 — the cash ledger and the group view

Stage 2 of [plan.md](plan.md) (layers 1 and 2). This note is step 1 of the
stage protocol. It was written on 2026-11-22, during the stage 1 soak.

## What the gate permits now

Gate 1 is not passed. The stage 1 soak started when the daily cron merged
(2026-11-21 19:03 UTC) and ends on **2026-12-05**. Until the owner passes
gate 1:

- **Permitted:** this note (step 1), the lab build (step 2) and the tests
  (step 3). These change nothing in production.
- **Not permitted:** to merge the stage 2 migration (step 4), the dry run in
  production (step 6) and all later steps.

The stage 2 PRs can be opened for review. They carry a "do not merge before
gate 1" line. The migration gets a new timestamp from the clock on the day it
merges, because `check-migrations.mjs` refuses a migration that is older than
one on `main`.

## What ships

Two PRs, so that two people can work at the same time. The contract between
them is the section "The statement" below.

| PR | Contents | Migration |
| :- | :------- | :-------- |
| A, "the cash ledger" | `ledger_account`, `ledger_ref_type` (seeded), `ledger_cash_line`, `ledger_group()`, `ledger_cash_statement()`, the rollback, the SQL tests, the lab run and its measurements | one |
| B, "the page" | `/ledger` (P&L by month), the pure read fold, the unit tests | none |

No row is stored except the two small seed tables. No job is added. No
extract job is changed.

### `ledger_account`

`code text primary key`, `name`, `kind` (`asset`, `liability`, `equity`,
`revenue`, `expense`), `parent_code`. The seed is the list in
[design.md](design.md). `authenticated` reads it; `anon` does not (C4).

### `ledger_ref_type`

One row for each `ref_type` that the stage 0 census found (H10, 61 values).

| Column | Meaning |
| :----- | :------ |
| `ref_type text primary key` | the ESI value |
| `account_in text` | the other account when `amount > 0` |
| `account_out text` | the other account when `amount < 0` |
| `transfer boolean` | the row moves ISK between two parties, and can be internal to a group |
| `verified boolean` | true only where stage 0 measured the behaviour (H3, H4, H6) |
| `note text` | the reason |

A `ref_type` with no row uses `9000`, and so does a side with no account. A
row with `amount = 0` uses `account_in`. The seed is made again from a new lab
copy (H10), because the first copy is gone. Where the census saw only one
side, the other side has the same account when the meaning is clear (a refund
of a fee credits the fee's account), so that a zero row or a refund does not
fall into Suspense. The seed lives in the migration and in `schema.sql`, and
the pure module `src/ledger/chart.ts` holds the same list; a test proves that
they agree.

Assumptions that the lab run must confirm or refute before the seed is fixed:

- `market_escrow` out and in go to `1100 Market escrow` (H6: a buy from a sell
  order names an escrow row; a buy-order fill has no journal row).
- `market_transaction` in is `4000`. A `market_transaction` out, if one
  occurs, has no account yet (inventory starts in stage 6): it goes to `1200`
  and the note says so.
- `player_donation`, `player_trading`, `corporation_account_withdrawal` and
  `contract_price` are `transfer = true`. `industry_job_tax` is a transfer
  too (H4: 8,170 character-to-corporation rows pair on the entry id).
- A hidden credit (stage 1, rule 3) has no journal row, so the cash view has
  no line for it. The cash proof (I-3) must count the hidden credits of the
  segment, as the chain does.

The lab run of 2026-11-22 confirmed each of these (see "Lab result"), with
one change: `corporation_account_withdrawal` stays `transfer = true` but is
not `verified`, because no pair of it falls inside the corporation journal.

### `ledger_cash_line` (view, `security_invoker`)

`union all` of the two journal tables. Two lines for each journal row:

| Column | Cash line | Other line |
| :----- | :-------- | :--------- |
| `side` | `cash` | `other` |
| `account_code` | `1000` (character), `1010` (corporation division) | from `ledger_ref_type` by the sign of `amount`, else `9000` |
| `amount` | `+amount` | `−amount` |

Common columns: `registration_id`, `corporation_id`, `division`, `wallet_key`
(the same expression as `ledger_wallet_segment`), `entry_id`, `date`,
`ref_type`, `transfer`, `verified`, `first_party_id`, `second_party_id`,
`context_id`, `context_id_type`. Debit is positive. Thus income of 100 ISK is
`+100` on cash and `−100` on a revenue account. A row with a null `amount`
gives no line and is counted (H2 found none).

The view adds no index. Each read must give a wallet owner and a date window,
so that it uses `character_wallet_journal_registration_id_date_idx` or
`corp_wallet_journal_corp_date_idx`. The PR shows the `explain`.

### `ledger_group()`

SQL, `security invoker`, `stable`. It returns the caller's group: one row for
each registration of the account (`registration_id`, `character_id`) and one
for each corporation that the account directs (`corporation_id`). The
director proof is the one in `src/app/structure/directors.ts`: a
`corp_job_access` row for job `corp-structures`, by a registration that is in
that corporation today. A corporation that the caller is only a member of is
not in the group (I-11).

### The statement

`ledger_cash_statement(p_from date, p_to date, p_scope text default 'group', p_wallet_key text default null) returns json`

- `p_from` is included, `p_to` is not. The window is at most 366 days; a
  longer window is an error (C2).
- `p_scope = 'group'`: all wallets of `ledger_group()`, with internal
  transfers left out. `p_scope = 'wallet'`: the one wallet `p_wallet_key`,
  which must be in the group, with all rows kept.
- Months are UTC months.

```json
{
  "window": { "from": "2026-10-01", "to": "2026-12-01" },
  "scope": "group",
  "wallets": [
    { "wallet_key": "…", "kind": "character", "registration_id": "…",
      "corporation_id": null, "division": null }
  ],
  "months": [
    {
      "month": "2026-10",
      "lines": [ { "account_code": "4000", "amount": "-123.45", "rows": 12 } ],
      "isk_moved": "1000.00",
      "suspense_isk": "5.00",
      "internal_rows": 4,
      "internal_isk": "200.00",
      "unpaired_transfers": 0,
      "proven": true,
      "not_proven": []
    }
  ],
  "suspense": [ { "ref_type": "…", "rows": 3, "isk_in": "5.00", "isk_out": "0.00" } ],
  "unpaired": [ { "date": "…", "wallet_key": "…", "ref_type": "…",
                  "amount": "…", "other_party_id": 0 } ]
}
```

- Amounts are strings with two decimals (`numeric(20, 2)`); the page uses
  `src/ledger/money.ts`.
- `lines` has the `other` side only, summed by account. The cash side is the
  negative of their sum.
- `isk_moved` is the sum of `abs(amount)` of the rows in the month.
  `suspense_isk` is the same sum for the rows on `9000`.
- **Internal:** a `transfer` row whose other party (`first_party_id` or
  `second_party_id`, the one that is not the wallet's owner) is a character
  or a corporation of the group.
- **Unpaired (I-7):** an internal transfer with no row of the opposite amount
  in the other wallet. The pair key is the entry id (H4). `unpaired` lists at
  most 100, oldest first; its `amount` is the journal amount (the cash side).
  An `industry_job_tax` row out whose two parties are the same is paired by
  its hidden credit (the rule of `src/ledger/check.ts`).
- **Wallets:** in the group scope, each group wallet with a row in the window
  or a stage 1 check. A corporation division with neither is not a wallet, as
  in stage 1.
- `suspense`: for each `ref_type` on `9000`, `isk_in` is the cash that came
  in and `isk_out` the cash that went out, both positive.
- **Proven:** a month of a wallet is proven when no segment of the wallet
  starts or ends inside the month except at the first and last row of the
  wallet, and the newest `ledger_check` row of the wallet is `ok`. A month of
  the group is proven when each wallet is, and `unpaired_transfers` is 0.
  `not_proven` gives the reasons: `break`, `check_failed`, `no_check`,
  `unpaired_transfer`.

The cash balance at a date is read from the `balance` column of the newest
row at or before the date. No read sums all history.

### `/ledger` (PR B)

A server component at `src/app/ledger/page.tsx`, behind `ledgerEnabled()` and
`isChancellor()`, as `/ledger/health` is. It calls the statement on the
cookie-session client. It shows: the P&L by month (revenue and expense
accounts, the sign turned for display), a wallet picker (group, or one
wallet), the trailing-months control, the Suspense list with its share, and
the "proven" or "not proven" label of each month with its reasons. The read
fold from the JSON to the table rows is a pure module with tests. PR B is
built against the JSON above with a fixture; it does not wait for PR A.

## Checks

| ID | How stage 2 proves it |
| :- | :-------------------- |
| I-3 | Lab: for each segment, the sum of the cash lines plus the hidden credits equals closing minus opening, to within one cent for each rounding step of the segment. Gate. |
| I-4 | `test/sql`: the two lines of each row sum to zero. |
| I-5 | `test/sql`: exactly two lines for each journal row. Lab: the Suspense share of ISK moved. Gate: below 1%, or a decision for each `ref_type` left. |
| I-7 | Lab: the count of unpaired internal transfers, by `ref_type`, with the cause. |
| I-11 | `test/sql`: an outsider reads zero rows from each object and gets an empty statement; a member who is not a director gets no corporation wallet in the group. |

**Parallel run (lab now, production after gate 1):** for the same window,
`4000` must equal the market sales of `/market`, and the `industry_job_tax`
income must equal `/structure/revenue`. Each difference is listed with its
cause.

**Read time:** the statement for 12 months of the owner's group, measured on
the lab with the production indexes. Above 500 ms, the gate report proposes a
day rollup; it is not built in this stage.

**Rollback:** `docs/ledger/rollback-stage-2.sql` drops the two functions, the
view and the two tables. It is tested in `test/sql`. No source table is
named.

## Budget

Stage 2 stores about 30 account rows and about 61 map rows, once, in the
migration. It adds no job and no daily write.

## Status

| Step | State |
| :--- | :---- |
| 1 Design note | ✅ this file |
| 2 Lab | ✅ 2026-11-22, see "Lab result" |
| 3 Tests | ✅ `test/sql/ledger_cash.sql`, `test/ledgerChart.test.ts` |
| 4 PR, migration | waits for gate 1 to merge |
| 5–9 | wait for gate 1 |

## Lab result (2026-11-22)

A new lab copy of the owner's account, read from production by
`pnpm run ledger-lab-copy` (the wallet, transaction and ledger tables only:
`--tables`). 414 pages, slowest page 0.94 s, no error. 9 characters, 3
corporations; 10 wallets with a journal (9 characters, 1 corporation
division). The stage 2 lab (`pnpm run ledger-lab-stage2`, see
[lab.md](lab.md)) loads it into a local database with the production indexes
and policies, cut from `schema.sql`, and runs the migration of this stage.

### The seed (H10)

61 `ref_type` values, the same 61 as stage 0. All 61 have a row in
`ledger_ref_type`; 7 are `verified` (H3, H4, H6), 5 are `transfer`.
`market_transaction` has no out row. `market_escrow` has 1,390 in rows (escrow
returned), so both of its sides are `1100`.

### Checks

| ID | Result | Verdict |
| :- | :----- | :------ |
| I-4 | 614,588 lines for 307,294 rows; no row whose two lines do not sum to zero | ✅ |
| I-5 | Exactly two lines for each row; 0 rows with a null amount | ✅ |
| I-5 | Suspense: 0 rows and 0 ISK of 34.6T ISK moved (all history); 0 in the 12-month statement | ✅ below 1% |
| I-3 | 618 of 618 segments: cash lines + hidden credits = closing − opening, to the cent but for 2.08 ISK of rounding over 488 one-cent steps. The corporation division of this copy has no self-paid tax, so 0 hidden credits | ✅ |
| I-7 | See below | ✅ explained |
| I-11 | `test/sql/ledger_cash.sql` | ✅ |

**I-7, unpaired internal transfers, all history.** Every unpaired row is older
than the first journal row of the wallet on its other side, so the other side
was never pulled. None is newer.

| `ref_type` | Internal rows | Paired | Unpaired | Unpaired, before the other journal starts |
| :--------- | ------------: | -----: | -------: | ----------------------------------------: |
| `contract_price` | 509 | 508 | 1 | 1 |
| `corporation_account_withdrawal` | 8 | 0 | 8 | 8 |
| `industry_job_tax` | 22,490 | 8,170 | 14,320 | 14,320 |
| `player_donation` | 2,339 | 2,334 | 5 | 5 |
| `player_trading` | 28,486 | 28,486 | 0 | 0 |

So in the 12-month statement (2025-12 to 2026-11), the five months before the
corporation journal starts (2026-05-02) are "not proven" with
`unpaired_transfer` (595 to 941 rows a month), and the seven months from 2026-05
are proven. No month has a `break`: the only segment that starts in the window
starts at the first row of the corporation division. This is correct: a character's tax to the
corporation before the corporation journal starts has no evidence of its
other side.

### Parallel runs (12 months, 2025-12-01 to 2026-12-01)

**Account 4000 against the `/market` sales rule** (sells of
`character_wallet_transaction` with `is_personal`, and of
`corp_wallet_transaction`; quantity × unit price):

| Months | 4000 | `/market` | Difference |
| :----- | ---: | --------: | ---------: |
| 2026-05 to 2026-11 | 996.5B | 996.5B | 0.00 in each month |
| 2025-12 to 2026-04 | 821.8B | 0 | 821.8B |

Cause of the difference: the transaction tables start on 2026-05-01. The 2,476
journal sells of the five earlier months come from the jEveAssets journal
import, and their transactions were never imported. No market sell is missing
from the journal.

**`industry_job_tax` income against the `/structure/revenue` rule** (the
corporation journal's incoming `industry_job_tax` rows, by month; the journal
starts 2026-05-02): in each of the seven months, the group statement's
`industry_job_tax` income equals the revenue page less the tax that our own
characters paid (internal: 1.23B of 12.18B over the seven months). The
difference is that one cause and nothing else.

### Read time

The 12-month statement of the owner's group (75,755 rows in the window, 10
wallets), on the lab (Postgres 16, 4 cores, `work_mem` 4 MB), as the
`authenticated` role with RLS:

| Read | Time |
| :--- | ---: |
| Group, first version | 4.1 s, of which JIT 3.4 s |
| Group, with `set jit = off` on the function | 0.52 to 0.56 s (5 runs) |
| One character wallet | 0.36 to 0.46 s |
| One corporation division | 0.28 s |

`explain` (auto_explain, the inner query): the character journal is read by a
sequential scan with the RLS filter (21% of its rows are in the window, so the
planner prefers it to `character_wallet_journal_registration_id_date_idx`);
the corporation journal likewise. The load of the window is about half the
time, the pairing (one hash aggregate of the transfer rows) and the JSON the
rest. A first version that filtered the wallet in the same step as the pairing
made the planner probe the pairs once per row (86 s for one wallet); the
pairing now runs before the scope filter.

The group read is just above the 500 ms line. As the contract says, the gate
report proposes a day rollup (one row per wallet, day, account); it is not
built in this stage. Two smaller options to weigh first: give the function a
larger `work_mem` (the read spills to temp files at 4 MB), or read the
`months` and `suspense` parts without the pairing when the scope is one
wallet.
