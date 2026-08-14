-- Create sheet_csv, which 20260723020000_add_sheet_csv.sql was supposed to
-- create and never did in production.
--
-- It was lost to the timestamp collision described in
-- 20260727000000_migration_history_composite_key.sql: two migrations were minted
-- in the same second — 20260723020000_add_sheet_csv and
-- 20260723020000_character_skill — and schema_migrations' primary key was
-- `(version)` alone, so only one of the pair could ever be recorded. Production
-- was then repaired by hand to unblock the queue behind it. The repair left the
-- history consistent (version 20260723020000 present, key widened to
-- (version, name)) but the add_sheet_csv DDL had never run, and no future
-- `supabase db push` would ever run it again — the history says it is applied.
--
-- Nothing noticed for three weeks because both readers fail quietly:
-- /sheets/[file] answered 500 to Google Sheets' IMPORTDATA fetcher, which
-- nobody sees, and the sde-mirror workflow only reaches its encodeSheets step
-- after a full ingest — which was itself failing earlier, on the schema-cache
-- bug fixed in #878. The first run that got far enough surfaced it as
--
--   sheet-csv: upsert failed:
--   Could not find the table 'public.sheet_csv' in the schema cache
--
-- which reads exactly like the transient PostgREST reload race that #878 dealt
-- with, and is nothing of the sort: the table simply is not there.
--
-- Idempotent throughout, because environments disagree about whether this ever
-- ran — a database built from schema.sql has the table, production does not.
-- The shape is copied verbatim from the original migration.
create table if not exists public.sheet_csv (
  name text primary key,
  data text not null,
  sde_build bigint not null,
  updated_at timestamptz not null default now()
);

alter table public.sheet_csv enable row level security;

drop policy if exists "Everyone reads sheet csv" on public.sheet_csv;
create policy "Everyone reads sheet csv"
  on public.sheet_csv
  for select
  to anon, authenticated
  using (true);

grant select on public.sheet_csv to anon, authenticated;
grant all    on public.sheet_csv to service_role;

-- The table is minted here rather than by ensure_sde_mirror_table(), so nothing
-- has told PostgREST to reload — and the sde-mirror run that writes it may come
-- long before any other DDL does. Ask directly.
notify pgrst, 'reload schema';
