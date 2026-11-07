# Ledger: double-entry accounting over the extracted data

Status: 📋 plan only, written 2026-11-07. Nothing is built. The owner asked
how an actual company would do the accounting that `/market` does by hand
(a sales report folded from two feeds, with contract payments matched in
after the fact). This document answers that with a derived ledger and
plans the work as PRs.

## Summary

The extracts stay the source of record. Nothing new is pulled from ESI. A
**ledger** is folded out of the extracted tables after each extract run,
the way `structure_measure_day` is (docs/structure-measure-rollup.md):

- The **wallet journals** are the spine. CCP keeps a general ledger for
  every wallet: each ISK movement is an entry with a `ref_type`, two
  parties, a `context_id` and a running `balance`. The balance makes the
  record provable: the entries of a period must sum to the change in
  balance.
- Market transactions, contracts and industry jobs are **sub-ledgers**. They
  explain an entry (what item, how many, to whom) and carry the item side
  the journal does not have.
- Each event becomes one `ledger_entry` with `ledger_posting` lines that
  sum to zero, under a seeded **chart of accounts**.
- The account's characters and the corporations they direct are one
  **group**. A posting between two members is **intercompany** and leaves
  the consolidated statements.
- **Inventory lots** give each item a cost basis, so a sale posts cost of
  goods beside revenue and the statements show margin, not turnover.

`/market` becomes a view over the sales sub-ledger. A new `/ledger` page
shows the P&L and the balance sheet per period.

## What the stack holds today

| Source                                                        | Rows                                                                                | Ledger use                                                                 |
| :------------------------------------------------------------ | :---------------------------------------------------------------------------------- | :------------------------------------------------------------------------- |
| `character_wallet_journal` (`registration_id, entry_id`)      | every ISK movement of a character; `ref_type`, `amount`, `balance`, parties, `context_id`, `tax`, `tax_receiver_id` | the spine of a character entity                                            |
| `corp_wallet_journal` (`corporation_id, division, entry_id`)  | the same for a corporation wallet, per division                                     | the spine of a corporation entity; a division is a sub-account of cash      |
| `character_wallet_transaction` / `corp_wallet_transaction`     | market trades: `type_id`, `quantity`, `unit_price`, `is_buy`, `client_id`, `location_id`, `journal_ref_id` | the item side of a `market_transaction` entry; `journal_ref_id` is the join |
| `character_contract_with_status` / `corp_contract_with_status` + `*_contract_item` | contracts and their included and requested items                             | the item side of `contract_price` / `contract_reward` entries              |
| `character_industry_job_over_time` / `corp_industry_job_over_time` | jobs with `cost`, `blueprint_id`, `runs`, `product_type_id`; bills from the SDE (`eiv.ts`, `lift.ts`) | materials consumed and product made; the item side of `industry_job_tax` entries |
| `character_asset_*` / `corp_asset_*`                           | the current and historical stock                                                    | the control total for inventory; opening balances                           |
| `market_price_over_time`, `market_adjusted_price_over_time`    | Jita split at any moment; CCP adjusted prices                                        | valuation of inventory and of an item with no cost basis                    |

ESI keeps 30 days of journal and transactions, and the tables only grow, so the
ledger reaches back as far as the extracts have run (character journal back to
2022 where the owner imported a jEveAssets profile).

## The model

Four tables, service-role writes, RLS on `owner_key` the way `structure_measure_day`
does it (own registrations, own corporations through `my_corporation_ids()`).

### `ledger_account` — the chart of accounts

A seeded, static list. Columns: `code text primary key`, `name`, `kind`
(`asset`, `liability`, `equity`, `revenue`, `expense`), `parent_code`.
World-readable. The seed lives in `schema.sql` and in the migration; the same
list is the pure module `src/ledger/chart.ts` the fold imports, and a test
asserts the two agree.

| code  | name                        | kind      |
| :---- | :-------------------------- | :-------- |
| 1000  | Cash                        | asset     |
| 1010  | Cash: corporation division  | asset     |
| 1100  | Market escrow               | asset     |
| 1200  | Inventory                   | asset     |
| 1210  | Inventory: work in progress | asset     |
| 1300  | Contract collateral held    | asset     |
| 1400  | Receivables                 | asset     |
| 2000  | Payables                    | liability |
| 2100  | Contract collateral owed    | liability |
| 3000  | Opening balance equity      | equity    |
| 3100  | Intercompany                | equity    |
| 4000  | Revenue: market sales       | revenue   |
| 4100  | Revenue: contract sales     | revenue   |
| 4200  | Revenue: services           | revenue   |
| 4300  | Revenue: bounties and loot  | revenue   |
| 4400  | Revenue: insurance          | revenue   |
| 4900  | Other income                | revenue   |
| 5000  | Cost of goods sold          | expense   |
| 5100  | Broker fees                 | expense   |
| 5110  | Sales tax                   | expense   |
| 5120  | Contract fees               | expense   |
| 5200  | Industry: install fees      | expense   |
| 5210  | Industry: facility tax      | expense   |
| 5300  | Structure fuel and services | expense   |
| 5400  | Clones and medical          | expense   |
| 5500  | Office and rent             | expense   |
| 5600  | Transport and courier       | expense   |
| 5900  | Other expense               | expense   |
| 9000  | Suspense: unclassified      | equity    |

Codes leave room; the list is a start, not a limit. Add an account with a
migration and a chart change together.

### `ledger_entry` — one economic event

| column          | meaning                                                                                                 |
| :-------------- | :------------------------------------------------------------------------------------------------------ |
| `id`            | bigint identity                                                                                         |
| `owner_key`     | generated from `registration_id` xor `corporation_id`, the entity whose books this is                   |
| `source`        | `journal`, `transaction`, `contract`, `industry_job`, `inventory_open`, `valuation`                    |
| `source_id`     | the row's key in its source (journal `entry_id`, `transaction_id`, `contract_id`, `job_id`)             |
| `posted_at`     | the event's own date (journal `date`, transaction `date`, contract `date_completed`, job `completed_date`) |
| `counterparty_id` | the other party (`first_party_id`/`second_party_id` minus ourselves, `client_id`, the other side of a contract) |
| `intercompany`  | true when the counterparty is another entity of the same account (see Consolidation)                    |
| `memo`          | the `ref_type`, a contract title, a product name                                                        |
| `recorded_at`   | when the fold wrote it                                                                                  |

Unique on `(owner_key, source, source_id)`, so posting is idempotent and a
rerun writes nothing.

### `ledger_posting` — the double-entry lines

| column       | meaning                                                                        |
| :----------- | :----------------------------------------------------------------------------- |
| `entry_id`   | the entry                                                                      |
| `line`       | 1..n                                                                           |
| `account`    | `ledger_account.code`                                                          |
| `amount`     | signed ISK, debit positive, credit negative; an entry's lines sum to zero      |
| `type_id`    | for inventory accounts, the item                                               |
| `quantity`   | for inventory accounts, the units moved, signed with the amount                |
| `lot_id`     | for a cost-of-goods line, the lot consumed                                     |

No check constrains the sign per account kind: a debit and a credit are
both valid on every account (a refund credits an expense). The fold
enforces the zero-sum rule and a test covers it; a SQL test confirms it
over every stored entry (`test/sql/ledger_balance.sql`).

### `inventory_lot` — the cost basis

| column          | meaning                                                                          |
| :-------------- | :------------------------------------------------------------------------------- |
| `id`            | bigint identity                                                                  |
| `owner_key`     | the holding entity                                                               |
| `type_id`       | the item                                                                         |
| `acquired_at`   | when the lot came in                                                             |
| `quantity`      | units acquired                                                                   |
| `remaining`     | units not yet consumed                                                           |
| `unit_cost`     | ISK per unit                                                                     |
| `basis`         | `purchase`, `contract`, `manufactured`, `opening`, `valued` (no cost known; Jita at the time) |
| `entry_id`      | the entry that acquired it                                                       |

**FIFO.** A consumption takes the oldest lot with `remaining > 0` first. The
order is `(owner_key, type_id, acquired_at, id)`, so the fold is deterministic
and a rerun over the same rows gives the same lots. Weighted average is the
alternative; FIFO is chosen because it keeps the audit trail per lot (a
cost-of-goods line names the lot it consumed), which is what a trader checks
when a margin looks wrong.

## The postings, by source

Debit is positive. "Cash" is `1000` for a character and `1010` for a
corporation division (`division` on the entry's memo).

### Journal entries (`src/ledger/journal.ts`)

The map from `ref_type` to postings. ESI's enum has about 130 members; the
fold knows the ones below and posts anything else to `9000 Suspense` with the
`ref_type` in the memo, so nothing is lost and the page can list what is
unclassified. The `amount` of the entry is always one leg against Cash; the
`tax` column (sales tax CCP took on the same entry) is a second leg.

| `ref_type`                                         | Cash   | other leg                                                              |
| :------------------------------------------------- | :----- | :--------------------------------------------------------------------- |
| `market_transaction`                               | ±amount | `1200 Inventory` on a buy (the sub-ledger adds `type_id`/`quantity`); `4000 Revenue: market sales` on a sell, and `5000 COGS` against `1200` from the lots |
| `market_escrow`                                    | −amount | `1100 Market escrow` (a buy order placed)                              |
| `market_escrow` release (positive)                 | +amount | `1100`                                                                 |
| `transaction_tax`                                  | −amount | `5110 Sales tax`                                                       |
| `brokers_fee`                                      | −amount | `5100 Broker fees`                                                     |
| `contract_price`                                   | ±amount | `4100 Revenue: contract sales` or `1200 Inventory`, per the contract's direction (`contractDirection`); `5000`/`1200` from the lots on a sale |
| `contract_reward`, `contract_reward_refund`        | ±amount | `5600 Transport` for a courier we issued, `4200 Services` for one we hauled; on a want-to-buy, `1200` |
| `contract_brokers_fee`, `contract_sales_tax`, `contract_auction_bid_corp`, `contract_reversal` | ±amount | `5120 Contract fees` (reversal credits it)                     |
| `contract_collateral`, `contract_collateral_payout`, `contract_collateral_refund`, `contract_deposit`, `contract_deposit_refund` | ±amount | `1300` (we posted it) or `2100` (we hold it) |
| `contract_auction_bid`, `contract_auction_bid_refund`, `contract_auction_sold` | ±amount | `1400 Receivables` while the auction runs; `1200`/`4100` when sold |
| `industry_job_tax`                                 | −amount | `5210 Industry: facility tax`                                           |
| `manufacturing`, `researching_*`, `copying`, `reaction`, `reprocessing_tax` | −amount | `5200 Industry: install fees` (the job sub-ledger moves it into `1210 WIP`) |
| `player_donation`, `player_trading`, `corporation_account_withdrawal` | ±amount | `3100 Intercompany` when the other party is in the group; else `4900`/`5900`; a donation PR 7 of the market plan tied to a gift contract posts as a contract sale |
| `bounty_prizes`, `agent_mission_reward`, `agent_mission_time_bonus_reward`, `ess_escrow_transfer`, `corporate_reward_payout` | +amount | `4300 Bounties and loot` |
| `insurance`                                        | ±amount | `4400 Insurance` (payout) or `5900` (premium)                           |
| `office_rental_fee`, `structure_gate_jump`, `infrastructure_hub_maintenance`, `upkeep_adjustment_fee` | −amount | `5500 Office and rent` |
| `jump_clone_installation_fee`, `jump_clone_activation_fee`, `clone_activation`, `clone_transfer`, `medical`, `skill_purchase` | −amount | `5400 Clones and medical` |
| `asset_safety_recovery_tax`, `docking_fee`, `planetary_import_tax`, `planetary_export_tax`, `planetary_construction`, `reprocessing_tax` | −amount | `5900 Other expense` |
| `lp_store`, `daily_challenge_reward`, `ess_escrow_transfer` | +amount | `4900 Other income` |

The `tax` column posts `5110 Sales tax` against Cash on the same entry (CCP
nets it out of the amount; the posting shows it).

### Market transactions (`src/ledger/transactions.ts`)

A transaction row joins its journal entry on `journal_ref_id`. The journal
fold made the Cash and Revenue/Inventory legs; this fold adds `type_id` and
`quantity` to the inventory leg, and on a sale consumes lots FIFO and posts
`5000 COGS` against `1200 Inventory` for the lots' cost. A sale of units no
lot covers (stock from before the record, loot, a gift) takes a `valued`
lot at the Jita split of the moment, marked so the margin reads as an
estimate.

### Contracts (`src/ledger/contracts.ts`)

A finished item exchange or auction. `contractDirection`
(`src/app/api/graphql/contracts.ts`) says which side we were on. The
included items are the inventory leg: on a purchase, one lot per item line
with the contract's price spread by the items' Jita value at the time
(a contract of ten things has one price); on a sale, FIFO consumption and
COGS as for a transaction. A gift matched to a donation (market plan PR 7)
posts as a contract sale at the donation amount. A contract between two
group members is intercompany: the items move between the two entities'
inventories at book cost, and no revenue is recognised.

### Industry jobs (`src/ledger/jobs.ts`)

On install: the bill's materials (ME-adjusted, as `lift.ts` computes it) move
from `1200 Inventory` into `1210 Work in progress` at their lot cost, FIFO,
and the install fee (`cost`, the journal's `manufacturing` entry) joins WIP.
On delivery: WIP becomes a `manufactured` lot of the product, unit cost =
WIP / units made. Research, copy and invention jobs are expense (`5200`) and
make no lot; an invention success's copy has no cost basis.

### Opening balances (`src/ledger/opening.ts`)

The ledger starts at a date (the oldest journal row an entity has). The
stock at that date, from the asset history, becomes `opening` lots at the
Jita split of the day against `3000 Opening balance equity`, so the balance
sheet balances from day one. A unit that later turns out to have a purchase
before the start keeps its opening cost; the start is a line, not a window.

### Reconciliation

The journal's `balance` column is the control. For each wallet and each UTC
day, the sum of Cash postings must equal the change in `balance` between the
last entry of the day and the last entry of the day before. A `ledger_check`
view lists the days that do not agree (a missing extract run, a journal gap
past ESI's 30 days), and the page shows them as a warning. Inventory has a
weaker control: the asset snapshot's units per type against the lots'
`remaining`; a difference is loot, loss or a gap, listed but not forced.

## Consolidation

The **group** is the account: its `registration` rows (characters) and the
corporations one of them directs (a `corp_job_access` row with job
`corp-structures`, the director proof `src/app/structure/directors.ts` uses).
A corporation a character belongs to without directing is **not** in the
group: the member sees the corp's journal under RLS, but its ISK is not the
owner's.

An entry whose counterparty is another group member is `intercompany`. The
consolidated statements (`ledger_statement(owner_keys, from, to,
consolidated => true)`) leave intercompany entries out on both sides; a
single entity's statement keeps them. This is the general form of the rule
the owner gave for contracts (market plan, phase 2), and it covers donations,
corp withdrawals, internal market trades (a character buying from an alt's
sell order shows as `market_transaction` with the alt as `client_id`) and
courier rewards paid to one's own hauler.

The group set is computed at fold time and stored on the entry, since a
character can leave a corporation; a change in membership re-posts nothing.

## Periods

A period is a UTC month. `ledger_statement` sums postings by account for a
range of entries; the P&L is revenue and expense accounts over the range,
the balance sheet is every asset, liability and equity account to the end of
it. No period is closed in the accounting sense (nothing is immutable), since
a late extract can post into a past month; the page says when a month's
figures last changed (`max(recorded_at)` over the month's entries).

## Reads

- `ledger_statement(owner_keys bigint[]/uuid[], from, to, consolidated)` —
  json: one row per account with the period's movement and the closing
  balance. SECURITY INVOKER; RLS on the tables scopes it.
- `ledger_sales(owner_keys, from, to)` — the sales sub-ledger: revenue
  postings with their item lines, counterparty, source and the COGS lines
  of the same entry, so `/market` draws margin per trade without the raw
  feeds.
- `ledger_check` — the reconciliation view.
- `/ledger` — P&L and balance sheet, a month picker, the unclassified list,
  the reconciliation warnings, a per-entity / consolidated toggle. Design
  per docs/design-system (tiles, one accent, numbers in `--mono`).
- MCP: `ledger_statement` and `ledger_sales` as read-only tools on the
  bearer client, and GraphQL `ledger` for Links, later.

## How it is fed

Each extract that writes a source table ends with a best-effort
`postLedger(tag, owner)` step (`src/jobs/ledgerPostings.js`, over the pure
folds under `src/ledger/`), the shape `recordStructureTenancy` and
`src/jobs/structureMeasures.js` have: read the source rows newer than the
entity's last posted `source_id` (journals are append-only and ids grow),
fold, insert under the unique key, never update. The journals post first,
then transactions and contracts (they need the Cash legs), then jobs.

A one-off `pnpm run ledger-backfill [--owner …]` (`src/jobs/ledgerBackfill.js`)
walks the whole history in `posted_at` order per entity, since lots depend on
order. It is the same code as the step with an unbounded budget. A
`--rebuild` deletes an entity's entries and lots and starts over; the sources
are untouched, so a rebuild is always safe.

## Decisions for the owner

1. **FIFO or weighted average** for the cost basis. FIFO recommended (per-lot
   audit trail).
2. **Group membership**: director proof only (recommended), or every
   corporation a character is in.
3. **Opening valuation**: Jita split (recommended) or CCP adjusted price.
4. **Where contract purchase cost is spread**: by Jita value of each item
   (recommended) or evenly by unit.

## PRs

### PR 1 — Chart, journal fold, tables
- Migration: `ledger_account` (seeded), `ledger_entry`, `ledger_posting`,
  RLS, the unique key, `ledger_check`. `schema.sql` updated.
- `src/ledger/chart.ts` (the seed as data), `src/ledger/journal.ts` (the
  `ref_type` map), `src/ledger/post.ts` (entry + postings, zero-sum check).
  Tests: every known `ref_type` posts and balances; an unknown one goes to
  suspense; the `tax` leg.
- `src/jobs/ledgerPostings.js` step called from both wallet-journal extracts;
  `pnpm run ledger-backfill`.
- `test/sql/ledger_balance.sql`.
- Result: a complete cash P&L with fees, per entity, from the journals.

### PR 2 — Consolidation and the statement RPC
- The group set (`src/ledger/group.ts`, pure, tested) and `intercompany` on
  the entry; `ledger_statement()`.
- A first `/ledger` page: P&L and balance sheet per month, per entity or
  consolidated, the unclassified list, the reconciliation warnings.

### PR 3 — Transactions and contracts, inventory lots
- Migration: `inventory_lot`, `type_id`/`quantity`/`lot_id` on postings.
- `src/ledger/lots.ts` (FIFO, pure, tested hard), `transactions.ts`,
  `contracts.ts`, `opening.ts`. Steps in the transaction and contract
  extracts; the backfill grows.
- Result: COGS and margin on every sale.

### PR 4 — Industry jobs
- `src/ledger/jobs.ts`: materials into WIP, WIP into a manufactured lot.
  Step in both industry-job extracts.

### PR 5 — `/market` on the sub-ledger
- `ledger_sales()`; `/market` reads it: margin per trade, per counterparty
  and per item beside the turnover it shows today; the feeds' direct reads
  go. The gift-contract match (market plan PR 7) moves into the contract
  fold.

### PR 6 — MCP and GraphQL
- `ledger_statement` / `ledger_sales` tools; a `ledger` GraphQL field for
  Links.

## Out of scope

- Valuing assets at market for an unrealised gain. The balance sheet carries
  inventory at cost.
- Corp market orders (not extracted) and their escrow.
- PI, LP, structure fuel as inventory (fuel is expensed when bought).
