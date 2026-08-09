-- SQL-level coverage for structure_tax_revenue() — the per-structure tax
-- breakdown behind the Tax Revenue table on /structure/[structureId].
--
-- The disclosure rule itself is pinned by industry_job_tax_facility.sql; this
-- file covers what the aggregation layered on top can get wrong: attributing a
-- job to the wrong structure, grouping days in local time instead of UTC,
-- dropping the station_id/facility_id fallback, or letting the window leak
-- older entries in.
--
-- Run against a THROWAWAY database from the repo root (same harness as
-- asset_share.sql): DATABASE_URL='postgresql://…/throwaway' pnpm run test:sql
begin;

do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin; exception when duplicate_object then null; end $$;

create schema if not exists auth;
create or replace function auth.uid() returns uuid
language sql stable
as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;

create table public.registration (
  id uuid primary key,
  user_id uuid,
  corporation_id bigint
);
create table public.character_industry_job_over_time (
  job_id bigint, registration_id uuid, station_id bigint, facility_id bigint, is_current boolean
);
create table public.corp_industry_job_over_time (
  job_id bigint, corporation_id bigint, station_id bigint, facility_id bigint, is_current boolean
);
create table public.corp_wallet_journal (
  corporation_id bigint, division smallint, entry_id bigint,
  date timestamptz, ref_type text, context_id bigint, amount numeric(20, 2), first_party_id bigint
);

insert into public.registration (id, user_id, corporation_id) values
  ('11111111-1111-1111-1111-111111111111', '99999999-0000-0000-0000-000000000001', 1000);

-- Jobs 1-3 in structure 60000001 (the one under test), job 4 in 60000002, and
-- job 6 carrying only station_id to exercise the coalesce fallback.
insert into public.character_industry_job_over_time values
  (1, '11111111-1111-1111-1111-111111111111', 60000001, 60000001, true),
  (2, '11111111-1111-1111-1111-111111111111', 60000001, 60000001, true),
  (3, '11111111-1111-1111-1111-111111111111', 60000001, 60000001, true),
  (4, '11111111-1111-1111-1111-111111111111', 60000002, 60000002, true),
  (6, '11111111-1111-1111-1111-111111111111', 60000001, null,     true);
insert into public.corp_industry_job_over_time values
  (5, 3000, null, 60000001, true);

-- Payer 7001 pays twice on 2026-08-08 and once on 2026-08-07; payer 7002 pays
-- once on 2026-08-07. Job 4's tax belongs to a different structure, and the
-- 2026-06-01 entry is outside every window used below.
insert into public.corp_wallet_journal values
  (1000, 1, 1, '2026-08-08T01:00:00Z', 'industry_job_tax', 1, 1000.00, 7001),
  (1000, 1, 2, '2026-08-08T23:30:00Z', 'industry_job_tax', 2,  500.00, 7001),
  (1000, 1, 3, '2026-08-07T12:00:00Z', 'industry_job_tax', 3,  250.00, 7001),
  (1000, 1, 4, '2026-08-07T12:00:00Z', 'industry_job_tax', 5,  700.00, 7002),
  (1000, 1, 5, '2026-08-08T12:00:00Z', 'industry_job_tax', 4, 9999.00, 7001),
  (1000, 1, 6, '2026-08-08T06:00:00Z', 'industry_job_tax', 6,  125.00, 7002),
  (1000, 1, 7, '2026-06-01T12:00:00Z', 'industry_job_tax', 1, 4242.00, 7001);

\i supabase/migrations/20260809000000_industry_job_tax_facility.sql
\i supabase/migrations/20260809080000_structure_tax_revenue.sql

set local test.uid = '99999999-0000-0000-0000-000000000001';

-- Payer 7001 on 2026-08-08: two entries, 1500 ISK. Both fall on the same UTC
-- day despite one landing at 23:30, which local-time grouping would split.
do $$
declare got record;
begin
  select * into got
  from public.structure_tax_revenue(60000001, '2026-08-01T00:00:00Z')
  where payer_id = 7001 and day = date '2026-08-08';
  assert got.jobs = 2, 'expected 2 jobs for 7001 on 08-08, got ' || coalesce(got.jobs::text, 'null');
  assert got.isk = 1500.00, 'expected 1500 ISK, got ' || coalesce(got.isk::text, 'null');
end $$;

-- The structure filter holds: job 4's 9999 ISK belongs to 60000002 and must
-- never appear in 60000001's total.
do $$
declare total numeric;
begin
  select coalesce(sum(isk), 0) into total
  from public.structure_tax_revenue(60000001, '2026-08-01T00:00:00Z');
  -- 1000 + 500 + 250 (char jobs) + 700 (corp job) + 125 (station_id-only job)
  assert total = 2575.00, 'expected 2575 ISK for this structure, got ' || total;

  select coalesce(sum(isk), 0) into total
  from public.structure_tax_revenue(60000002, '2026-08-01T00:00:00Z');
  assert total = 9999.00, 'the other structure should carry its own tax, got ' || total;
end $$;

-- A corp-installed job (5, facility_id only) and a station_id-only job (6) both
-- resolve through the coalesce.
do $$
declare n int;
begin
  select count(*) into n
  from public.structure_tax_revenue(60000001, '2026-08-01T00:00:00Z')
  where payer_id = 7002;
  assert n = 2, 'payer 7002 should have a row on each of two days, got ' || n;
end $$;

-- Grouping is one row per (payer, day), not one per entry.
do $$
declare n int;
begin
  select count(*) into n from public.structure_tax_revenue(60000001, '2026-08-01T00:00:00Z');
  -- 7001 on 08-08 and 08-07; 7002 on 08-08 and 08-07.
  assert n = 4, 'expected 4 (payer, day) rows, got ' || n;
end $$;

-- The window excludes the June entry, which would otherwise inflate 08-08.
do $$
declare total numeric;
begin
  select coalesce(sum(isk), 0) into total
  from public.structure_tax_revenue(60000001, '2026-05-01T00:00:00Z');
  assert total = 6817.00, 'a wider window should pull the June entry in, got ' || total;
end $$;

-- Ordering is newest day first, so the page can render rows as returned.
do $$
declare days date[];
begin
  select array_agg(day) into days from public.structure_tax_revenue(60000001, '2026-08-01T00:00:00Z');
  assert days[1] >= days[array_length(days, 1)], 'rows should come back newest day first';
end $$;

-- A caller with no journal entries of their own gets nothing, since the
-- delegated disclosure rule scopes to their corps.
set local test.uid = '99999999-0000-0000-0000-000000000002';
do $$
declare n int;
begin
  select count(*) into n from public.structure_tax_revenue(60000001, '2026-08-01T00:00:00Z');
  assert n = 0, 'an unentitled caller must get nothing, got ' || n;
end $$;

rollback;
