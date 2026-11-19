# Ledger stage 1 — the journal-gap alarm

Stage 1 of docs/ledger/plan.md (layer 0 in production). The owner said "go"
on 2026-11-19. This note tells what ships, what is assumed, and the budget.

## What ships in this PR

| Part | Where |
| --- | --- |
| Tables `corp_wallet`, `ledger_wallet_segment`, `ledger_check` | `supabase/migrations/20261119091512_ledger_check.sql`, `schema.sql` |
| Rollback | `docs/ledger/rollback-stage-1.sql` (apply as a new migration) |
| SQL test: RLS, grants, rollback | `test/sql/ledger_check.sql` |
| The corp balance pull: one `GET /corporations/{id}/wallets/` per corporation, best-effort | `src/jobs/corpWalletJournal.js`, `src/jobs/corpWalletFields.js` |
| The one-cent rule and chain continuation | `src/ledger/chain.ts` |
| The pure check rules | `src/ledger/check.ts` |
| The job, CLI only | `src/jobs/ledgerCheck.ts`, `pnpm run ledger-check [-- --dry-run] [--budget N]` |
| The lab run of the rules | `src/ledger/labCheck.ts`, `pnpm run ledger-lab-check` |
| The page `/ledger/health`, Chancellor only, behind the `ledger` flag | `src/app/ledger/health/page.tsx`, `src/ledger/health.ts`, `src/ledger/flag.ts` |

## What does NOT ship in this PR

- No workflow, no cron route, no `vercel.json` entry. So when this PR
  merges, nothing writes to the ledger tables. The only new live write is the
  corp balance pull into `corp_wallet`.
- A second PR adds the workflow and the cron, at a quiet minute, after the
  dry run on production (protocol step 6).

## The rules of a check (per wallet)

1. **Continue or rebuild.** The job reads the stored segments. It counts the
   journal rows at or before the last stored entry. If the count equals the
   sum of `row_count`, it reads only the rows after the last entry and
   continues the last segment. If not, rows came in late inside a span that
   was already checked, and the job rebuilds the whole chain.
2. **One cent is rounding.** A step off by exactly 0.01 ISK stays in the
   segment and is counted in `rounding_steps` (owner decision 2026-11-19).
3. **Snapshot compare (I-9).** The newest balance snapshot
   (`character_wallet`, or the new `corp_wallet`) against the journal balance
   at that moment: `equal`, `one_cent`, `differs` or `none`.
4. **Pull age.** The newest heartbeat of `character-wallet-journal` or
   `corp-wallet-journal` with `ok` and no skip. Older than 7 days fails.
5. **Verdict.** A new break, a snapshot that `differs`, or a stale pull fails
   the wallet. A rebuild alone is a notice. The first run of a wallet is a
   baseline: its old gaps are recorded, not raised.
6. **Writes.** Only new or changed segments are upserted; segments that a
   rebuild merged away are deleted; one `ledger_check` row per wallet. A dry
   run writes nothing and prints the same summary.

## Load on production

- Journal reads use keyset pages of 1,000 rows with a 200 ms pause.
- After the first run, a daily run reads only the rows newer than the last
  stored entry: at most a few hundred rows per wallet.
- **Row budget (I-14).** The job plans each wallet's writes before it makes
  them. A wallet that would cross the budget is not written, and the run
  stops and fails. The default budget is 3,000.

## Lab result (2026-11-19, the owner's account copy)

| Measure | Value |
| --- | --- |
| Wallets | 10 |
| Journal rows | 307,017 |
| Segments | 618 (1,106 without the one-cent rule) |
| One-cent steps | 488 |
| Writes on the first run | 628 |
| Largest daily run, writes | 13 |
| Incremental chain equals full chain | yes |
| Read time, whole copy | 4.4 s |
| Fold time | 0.6 s |

So the production budget for the first run is the lab figure plus 20%, about
760 rows, well under the default 3,000. Other accounts add a few rows per
wallet.

## The flag

The page reads the Vercel flag `ledger` and fails closed. With the flag off,
or not created, `/ledger/health` is a 404. The flag is not created yet; the
owner creates it, or tells us to.
