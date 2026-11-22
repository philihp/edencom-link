# The ledger lab

Status: built 2026-11-17 (stage 0 of [plan.md](plan.md)); run on 2026-11-17
(stage 0) and 2026-11-22 (stage 2). The owner decided on 2026-11-17 that a
copy from production is OK at any time.

The lab is a copy of one account's wallet, contract and industry job rows in
a Postgres on the owner's computer. All heavy analysis of the ledger runs
here, not on production (guard C2). The copy is also a second backup of the
wallet tables (guard C1).

## Parts

| Part | What it does |
| :--- | :----------- |
| `src/ledger/labCopy.ts` | Reads the rows from production, read-only, and writes CSV files. Writes to no database. |
| `src/ledger/labSpec.ts` | The tables, the columns, the partitions and the keyset paging. Pure; tested. |
| `docs/ledger/lab/schema.sql` | Makes the schema `ledger_lab` and its stand-in tables. |
| `src/ledger/lab.ts` | `load` makes the schema and loads a copy; `census` prints the report. |
| `docs/ledger/census_views.sql` | The census questions H1 to H11, as temporary views. |
| `docs/ledger/census.sql` | The report: each view, with a heading. |
| `src/ledger/labGuard.ts` | Refuses each lab command unless the database is on this computer (guard C8). |
| `test/sql/ledger_census.sql` | Checks each census view on rows with known answers. |
| `src/ledger/labStage2.ts` | Stage 2: makes a lab database with the production shape of the journals and runs the stage 2 migration on the copy. |
| `docs/ledger/lab/stage-2-measure.sql` | Stage 2: the checks I-3, I-4, I-5, I-7, the parallel runs and the read time. Reads only. |

## Steps

1. **Check the conditions.** The owner said on 2026-11-17 that a copy from
   production is OK at any time (plan section 8, decision 1); `--confirm`
   records that. Run at a quiet hour. Do not run if the production
   database was restarted in the last 24 hours (the stop conditions of the
   plan).
2. **Copy.** With `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` of production
   in `.env`:

   ```sh
   pnpm run ledger-lab-copy -- --user <account uuid> --dry-run --confirm   # counts the partitions only
   pnpm run ledger-lab-copy -- --user <account uuid> --confirm
   ```

   `--tables a,b,c` copies only those tables (the others get a file with the
   header only). Stage 2 needs `character_wallet`,
   `character_wallet_journal`, `corp_wallet_journal`,
   `character_wallet_transaction`, `corp_wallet_transaction`,
   `corp_job_access`, `ledger_wallet_segment` and `ledger_check`: about 410
   pages instead of 2,100, because it skips the contract items.

   The files go to `lab/ledger-copy/` (in `.gitignore`; never commit them).
   `manifest.json` records the row counts, the number of pages and the
   slowest page.
3. **Start a local Postgres.** The Supabase local stack (`supabase start`)
   is the default target. Any other local Postgres is set with
   `LAB_DATABASE_URL`.
4. **Load, then run the census.**

   ```sh
   pnpm run ledger-lab -- load
   pnpm run ledger-lab -- census > lab/census.txt
   ```

5. **Write `docs/ledger/measurements.md`** from `lab/census.txt`: totals and
   counts only, the wallet labels as they are, no names.

## Stage 2

Stage 2 measures a view and two functions that read the journals through
their production indexes and policies. So its lab is a database of its own,
not the schema `ledger_lab`:

```sh
pnpm run ledger-lab-stage2 -- setup      # makes the database ledger_stage2 and loads lab/ledger-copy
pnpm run ledger-lab-stage2 -- measure    # prints the stage 2 checks
```

The database is `LAB_STAGE2_DATABASE_URL`, else `ledger_stage2` on the
Supabase local stack. `setup` drops and makes its schema `public`, so the
runner refuses a database that is not on this computer or whose name does not
start with `ledger_`. The journal tables, their indexes and their policies are
cut from `schema.sql`, so the lab has the production shape of the day; the
copy goes in with `\copy`, and one lab account owns every registration.

## Load on production

The copy reads one page of at most 1,000 rows at a time. Each page is an
index range scan: an equality on the owner (a registration, a corporation,
or a corporation wallet division), then `key > last key seen`, in key order.
No page uses an offset, and no page reads rows it does not return. There is
a pause (300 ms by default) after each page and each partition.

On the first error, the copy stops. It does not retry: a slow or failed page
is a stop condition of the plan, and a retry adds load to a database that is
already in trouble. A rerun starts again from the start.

The copy reads only the columns the census needs from the wallet tables.
`reason` and `description` of the journals are not copied. The contract and
industry job tables are copied as one JSON document per row; the census does
not read them.

## What the lab is not

- It is not the Supabase local stack's `public` schema. The load drops and
  makes only `ledger_lab`.
- It does not hold other accounts. The copy is for one account.
- It is not a replacement for Supabase backups (plan section 8, decision 2).
