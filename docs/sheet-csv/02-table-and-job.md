# PR 2: the `sheet_csv` table and the `sheet-csv` job

## Goal

Persist the five CSVs so the serve route (PR 4) reads rows instead of
re-encoding. Mirrors the `esf_data` + `src/jobs/esfData.js` pair exactly.

## Table

New table `sheet_csv`, same shape and policies as `esf_data` except the data
column is plain text (CSV is text; base64 exists in `esf_data` only because
protobufs are binary):

```sql
create table public.sheet_csv (
  name text primary key,          -- e.g. 'types-twines.csv'
  data text not null,             -- the CSV body, BOM included
  sde_build bigint not null,      -- the build the row was encoded from
  updated_at timestamptz not null default now()
);
alter table public.sheet_csv enable row level security;
create policy "sheet_csv is world readable" on public.sheet_csv
  for select using (true);        -- writes: service role only (no policy)
```

Two places, per the schema rules in CLAUDE.md:

1. `schema.sql` — add the table (and its drop) so a fresh reset stays correct.
2. A **new** migration under `supabase/migrations/` with a fresh timestamp
   (`pnpm run db:new sheet_csv`). Never rename existing migration files.

Grant note: copy whatever `grant select` the `esf_data` migration issued to
`anon`/`authenticated` so PostgREST exposes it to the anon client.

## Job

`src/jobs/sheetCsv.js`, a line-for-line sibling of `src/jobs/esfData.js`:

- `runSheetCsv({ build, force })`:
  - `build` defaults to the latest completed `sde_mirror_state` build (same
    `latestCompletedBuild()` query — consider extracting it to `src/jobs/lib.js`
    or a shared helper rather than copy-pasting a third time if `esfData.js`
    wants it too; two copies is the current count, judgement call).
  - Skip path: unless `force`, no-op when `sheet_csv` already holds every
    `SHEET_FILE_NAMES` entry stamped with this build (the `alreadyEncoded`
    check).
  - Otherwise `encodeSheetCsv()` and upsert the rows (7 files, see README)
    (`onConflict: 'name'`) via `sudoSupabase`, stamped with `sde_build` and a
    shared `updated_at`.
- `cli(import.meta.url, 'sheet-csv', () => runSheetCsv())` at the bottom, and
  a `"sheet-csv": "node src/jobs/sheetCsv.js"` script in `package.json`, so
  the job name matches the npm script and heartbeat conventions.

## Bootstrap cron route

`/api/cron/sheet-csv` (`src/app/api/cron/sheet-csv/route.ts`): a copy of the
existing `/api/cron/esf-data` route — `requireCronSecret`, then
`runSheetCsv()` with `?force=1` mapped to `force: true`. **Deliberately
unscheduled** (no `vercel.json` `crons` entry): its jobs are (a) first-time
bootstrap before the nightly workflow has run, and (b) manual re-encode after
a code change to the transform, without waiting for tonight's mirror.

## Verification

- `pnpm run db:push` applies the migration cleanly.
- `pnpm run sheet-csv` populates seven rows; re-running logs the skip path;
  `--`-less `force` via the route re-encodes.
- Row content matches PR 1's parity-checked output (spot-check `data` for one
  file against the CLI artifact).
