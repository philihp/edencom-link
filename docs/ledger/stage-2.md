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

A `ref_type` with no row uses `9000`. A row with `amount = 0` uses
`account_in`. The seed is made again from a new lab copy (H10), because the
first copy is gone. The seed lives in the migration and in `schema.sql`, and
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
  most 100.
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
| I-3 | Lab: for each segment, the sum of the cash lines plus the hidden credits equals closing minus opening. Gate. |
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
| 2 Lab | 🔧 |
| 3 Tests | 🔧 |
| 4 PR, migration | waits for gate 1 to merge |
| 5–9 | wait for gate 1 |
