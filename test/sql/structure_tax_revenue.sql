-- SQL-level coverage for structure_tax_revenue() — the per-structure tax
-- breakdown behind the Tax Revenue table on /structure/[structureId].
--
-- The disclosure rule itself is pinned by industry_job_tax_facility.sql; this
-- file covers what the aggregation layered on top can get wrong: attributing a
-- job to the wrong structure, grouping days in local time instead of UTC,
-- dropping the station_id/facility_id fallback, letting the window leak older
-- entries in, or netting an outgoing entry against an incoming one (a job
-- installed AS THE CORPORATION into its own structure only ever writes the
-- outgoing side, so netting reported such a structure as earning negative
-- revenue).
--
-- It also pins the measures apart. `isk_self_paid` is the subset billed at OUR
-- OWN RATE — the installer's own corporation owns the structure — so rent paid
-- into somebody else's must never land in it, which is what the earlier
-- every-outgoing-entry reading got wrong. `isk_paid` is the wider figure: every
-- charge we paid, including a member's personal job, whose only record is the
-- incoming receipt because no character wallet journal exists.
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
-- Who owns what. 60000001 is ours (corp 1000); 60000003 belongs to somebody
-- else, so tax paid into it is rent rather than a charge we billed ourselves.
create table public.corp_structure (
  structure_id bigint primary key, corporation_id bigint
);
create table public.corp_wallet_journal (
  corporation_id bigint, division smallint, entry_id bigint,
  date timestamptz, ref_type text, context_id bigint, amount numeric(20, 2), first_party_id bigint
);

insert into public.registration (id, user_id, corporation_id) values
  ('11111111-1111-1111-1111-111111111111', '99999999-0000-0000-0000-000000000001', 1000);
insert into public.corp_structure values (60000001, 1000), (60000003, 2000);

-- The live-rows view the aggregation reads to tell a personal job from a corp
-- one; the real schema defines it the same way.
create view public.character_industry_job as
  select * from public.character_industry_job_over_time where is_current;

-- Jobs 1-3 in structure 60000001 (the one under test), job 4 in 60000002, and
-- job 6 carrying only station_id to exercise the coalesce fallback.
insert into public.character_industry_job_over_time values
  (1, '11111111-1111-1111-1111-111111111111', 60000001, 60000001, true),
  (2, '11111111-1111-1111-1111-111111111111', 60000001, 60000001, true),
  (3, '11111111-1111-1111-1111-111111111111', 60000001, 60000001, true),
  (4, '11111111-1111-1111-1111-111111111111', 60000002, 60000002, true),
  (6, '11111111-1111-1111-1111-111111111111', 60000001, null,     true);
insert into public.corp_industry_job_over_time values
  (5, 3000, null, 60000001, true),
  -- Our own corporation's job, run in a structure somebody else owns.
  (7, 1000, null, 60000003, true);

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
  (1000, 1, 7, '2026-06-01T12:00:00Z', 'industry_job_tax', 1, 4242.00, 7001),
  -- Tax our own corporation PAID for job 3, on a (payer, day) that already has
  -- an incoming row — so the split shows up in the measures without perturbing
  -- any of the row/day counts asserted below.
  (1000, 1, 8, '2026-08-08T02:00:00Z', 'industry_job_tax', 3, -300.00, 7001),
  -- Rent: our corporation paying tax into a structure it does not own.
  (1000, 1, 9, '2026-08-08T03:00:00Z', 'industry_job_tax', 7, -450.00, 7001);

\i supabase/migrations/20260809000000_industry_job_tax_facility.sql
\i supabase/migrations/20260809080000_structure_tax_revenue.sql
\i supabase/migrations/20260822120000_structure_tax_revenue_split_signs.sql
\i supabase/migrations/20260824234011_structure_tax_paid.sql

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

-- The two directions stay apart. An outgoing entry must not net against the
-- incoming ones (which would drop 7001's 08-08 total from 1500 to 1200), nor
-- inflate the received job count; it lands in its own measures, sign flipped so
-- every column reads positive.
--
-- 7001 on 08-08 is three charges in our own structure: jobs 1 and 2 arriving
-- from a member's personal jobs (1000 + 500) and job 3's 300 going out as the
-- corporation billed itself. All three were billed at our own rate, and all
-- three are tax our side paid — the receipts because no character journal
-- records the member's side, the outgoing one directly.
do $$
declare got record;
begin
  select * into got
  from public.structure_tax_revenue(60000001, '2026-08-01T00:00:00Z')
  where payer_id = 7001 and day = date '2026-08-08';
  assert got.isk = 1500.00, 'received ISK must not be netted against tax paid, got ' || got.isk;
  assert got.jobs = 2, 'the outgoing entry must not count as a received job, got ' || got.jobs;
  assert got.isk_self_paid = 1800.00, 'expected 1800 own-rate ISK, got ' || got.isk_self_paid;
  assert got.self_paid_jobs = 3, 'expected 3 own-rate charges, got ' || got.self_paid_jobs;
  assert got.isk_paid = 1800.00, 'expected 1800 paid ISK, got ' || got.isk_paid;
  assert got.paid_jobs = 3, 'expected 3 paid charges, got ' || got.paid_jobs;
  -- Every entry once: what the leaderboard ranks. Revenue and taxes paid
  -- overlap here, so adding them would count 1500 twice.
  assert got.isk_total = 1800.00, 'expected 1800 total ISK, got ' || got.isk_total;
  assert got.total_jobs = 3, 'expected 3 entries, got ' || got.total_jobs;
end $$;

-- A CORP job somebody else installed here is revenue and nothing else: we did
-- not pay it, and its payer's own wallet is where their side would live.
do $$
declare got record;
begin
  select * into got
  from public.structure_tax_revenue(60000001, '2026-08-01T00:00:00Z')
  where payer_id = 7002 and day = date '2026-08-07';
  assert got.isk = 700.00, 'expected 700 revenue, got ' || got.isk;
  assert got.isk_paid = 0, 'a corp job of theirs is not tax we paid, got ' || got.isk_paid;
  assert got.paid_jobs = 0, 'expected 0 paid charges, got ' || got.paid_jobs;
  -- Zero rather than null, so the page can sum the column without coalescing.
  assert got.isk_self_paid = 0, 'expected 0, got ' || coalesce(got.isk_self_paid::text, 'null');
  assert got.self_paid_jobs = 0, 'expected 0, got ' || coalesce(got.self_paid_jobs::text, 'null');
end $$;

-- Rent is tax we paid, but never tax we billed ourselves. Structure 60000003
-- belongs to corp 2000, so our corporation's 450 is paid but NOT own-rate —
-- the distinction the every-outgoing-entry reading collapsed, which reported a
-- saving on ISK that was charged at somebody else's rate.
do $$
declare got record;
begin
  select * into got
  from public.structure_tax_revenue(60000003, '2026-08-01T00:00:00Z')
  where payer_id = 7001 and day = date '2026-08-08';
  assert got.isk = 0, 'rent brings in no revenue, got ' || got.isk;
  assert got.isk_paid = 450.00, 'expected 450 paid as rent, got ' || got.isk_paid;
  assert got.isk_self_paid = 0, 'rent is not billed at our own rate, got ' || got.isk_self_paid;
  assert got.self_paid_jobs = 0, 'expected 0 own-rate charges, got ' || got.self_paid_jobs;
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
