# Ledger measurements (stage 0)

Status: measured 2026-11-17, on a lab copy of the owner's account. This file
gives totals and counts only. A wallet is a label (`character #n`,
`corporation #n`), not a name or an id. It answers the census questions H1
to H11 of [plan.md](plan.md), stage 0.

## The copy

| Item | Value |
| :--- | :---- |
| Account | the owner's: 9 characters, 3 corporations |
| Read | 2026-11-17 20:28 to 20:45 UTC, 2,136 pages, 300 ms pause, slowest page 1.03 s, no error |
| Rows | character_wallet 11,587; character_wallet_journal 294,347; corp_wallet_journal 12,670; character_wallet_transaction 12,896; corp_wallet_transaction 2; contracts 155,683; contract items 1,345,388; contract status rows 203,659; industry job rows 15,109 |
| Wallets with a journal | 9 characters, 1 corporation division (2 of the 3 corporations have no journal) |

The census ran on a local Postgres 16 in 7 minutes (no indexes beyond the
primary keys). The census reads whole tables. This time confirms that it
must not run on production.

## Results

| ID | Question | Result | Assumption |
| -- | :------- | :----- | :--------- |
| H1 | Is entry id order time order? | Yes. 0 of 307,007 adjacent pairs go back in time. 122,139 pairs have the same second, so entry id is the only usable order. | ✅ confirmed |
| H2 | Does the chain rule hold? | 99.54% to 99.80% for each character wallet; 100% for the corporation division. No null `amount` or `balance`. Of 1,096 breaks, **488 are exactly one cent**, all on `transaction_tax` (rounding, not a missing row). The other **608 are real gaps, all in rows from the jEveAssets import**. | ✅ confirmed, with a one-cent rule (see below) |
| H3 | What is `tax`? | 195 rows have a tax (`bounty_prizes`, mission rewards). Where the chain can tell, the balance moves by `amount` in every case, never by `amount ± tax`. The tax is already out of `amount`. | ✅ `tax` is an attribute, not a third leg |
| H4 | Do two sides of a transfer share one entry id? | Yes. `player_donation` 2,332 rows, `player_trading` 28,486, `contract_price` 508, character to corporation `industry_job_tax` 8,170: each pairs on the same entry id with the opposite amount. Market trades between our characters (14 rows) do **not**: each side has its own entry id. Of the 14,337 rows whose other side is missing, 14,332 are older than the corporation's first journal row (2026-05-02). | ✅ confirmed for transfers; market trades pair by date and amount |
| H5 | Do the two sides of one trade share a `transaction_id`? | No. 0 pairs of our journal rows name the same transaction. The 14 trades between our own characters have a different transaction id on each side. | ❌ refuted: the key `transaction_id` loses no row. No repair PR is needed before stage 3. |
| H6 | Is amount = quantity × price? What does a buy post? | **Sell:** the journal row names the transaction in `context_id` (all 2,694 sells). `journal_ref_id` names it for only 33. **Buy from a sell order:** `journal_ref_id` names a `market_escrow` row of exactly −quantity × price (3,552 buys). **Buy-order fill:** no journal row (6,652 buys); the ISK left the wallet as `market_escrow` when the order was placed. | ✅ amount = quantity × price where linked; the link rule is per side |
| H7 | `context_id_type` by ref_type | Industry rows carry `industry_job_id`, contract rows `contract_id`, market rows `market_transaction_id`, `market_provider_tax` and `player_trading` a structure id. `transaction_tax` and `brokers_fee` carry **no** context. | ✅ fees need a date rule to link to a trade (stage 3) |
| H8 | Do imported rows chain? | Imported: 284,589 rows from 2021-06-14 to 2026-09-10, 99.62% of pairs hold, all 608 real gaps are here. Extracted (since 2026-09-10 for characters, 2026-05-02 for the corporation): 22,428 rows, **no real gap** (5 one-cent breaks). | ✅ "proven" can reach back to 2021, by segments |
| H9 | Do wallet snapshots agree? | 7,396 equal; **4,188 differ by exactly one cent** (the snapshot is one cent lower); 3 differ by more (June, July, September, in the import era). 99.97% agree within one cent. | ✅ with a one-cent tolerance; no time tolerance needed |
| H10 | ref_types, signs, ISK | 61 ref_types. The largest by ISK: `market_escrow` out 7.18T, `market_transaction` in 6.19T, `player_donation` in 5.42T and out 5.39T, `contract_price` in 2.81T and out 2.75T. `player_trading` has 28,795 zero-amount rows. Full table in the census output. | seed for `ledger_ref_type` |
| H11 | Sizes and segments | Lab sizes: journal 57 MB (294k rows), the rest under 3 MB each. Segments: 1 for the corporation division, 23 to 584 per character. The net ISK the gaps leave out is 14.1B over 5 years, 12.2B of it in one character. | budgets for stage 1 |

## What this changes in the plan

1. **One-cent rule.** The chain rule must accept a step of exactly 0.01 ISK
   on `transaction_tax` as rounding. Otherwise each such row splits a
   segment and raises a false alarm (5 in the extracted rows already). The
   wallet compare (I-9) needs the same one cent. **Decided by the owner
   2026-11-19:** a step of exactly 0.01 ISK rounds to zero. It is a
   "rounding" break that does not split the segment and is counted in
   `ledger_check`.
2. **No H5 repair.** The transaction tables keep their key.
3. **Gate 0 passes.** The chain holds for 99.5% or more of the pairs in each
   wallet, and for all extracted rows with the one-cent rule.
4. **The extract is complete since it started.** The alarm of stage 1 has a
   clean base: every break it finds from now on is new.
5. **Two of the three corporations have no journal.** Stage 1 shows them
   as "no data", not as "proven".

## How to run it again

[lab.md](lab.md). The copy needs the owner's OK each time.
