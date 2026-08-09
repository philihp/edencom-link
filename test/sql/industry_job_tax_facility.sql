-- SQL-level coverage for industry_job_tax_facility() — the disclosure rule that
-- lets /structure/revenue attribute another player's industry job to the
-- structure it ran in.
--
-- The rule the function exists to enforce, in one sentence: the structure owner
-- who was paid tax for a job learns which of their structures it ran in — and
-- nothing else about that job. It is security definer, so it reads every table
-- with RLS bypassed and the caller's scope lives entirely in its own exists()
-- clause. That makes it exactly the kind of boundary worth pinning down here:
-- a wrong predicate leaks strangers' industry activity and no RLS policy is
-- standing behind it to catch the mistake.
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

-- Stand-ins for the three tables the function reads. RLS is enabled on all of
-- them with no policy at all: under a security definer function that is a
-- no-op (the owner bypasses it), which is precisely the condition the real
-- deployment runs under and the reason the scoping has to be explicit. If the
-- function ever loses its exists() clause, these tables will not save it — and
-- the assertions below will fail, which is the point.
create table public.registration (
  id uuid primary key,
  user_id uuid,
  corporation_id bigint
);
create table public.character_industry_job_over_time (
  job_id bigint, registration_id uuid, station_id bigint, facility_id bigint,
  product_type_id bigint, runs int, is_current boolean
);
create table public.corp_industry_job_over_time (
  job_id bigint, corporation_id bigint, station_id bigint, facility_id bigint,
  product_type_id bigint, runs int, is_current boolean
);
create table public.corp_wallet_journal (
  corporation_id bigint, division smallint, entry_id bigint,
  ref_type text, context_id bigint, context_id_type text, amount numeric(20, 2)
);
alter table public.registration                     enable row level security;
alter table public.character_industry_job_over_time enable row level security;
alter table public.corp_industry_job_over_time      enable row level security;
alter table public.corp_wallet_journal              enable row level security;

-- Two accounts. `owner` runs corp 1000 and owns the structures; `stranger` is
-- another player using the site, whose jobs live under their own registration
-- and are invisible to `owner` through every ordinary path.
insert into public.registration (id, user_id, corporation_id) values
  ('11111111-1111-1111-1111-111111111111', '99999999-0000-0000-0000-000000000001', 1000),
  ('22222222-2222-2222-2222-222222222222', '99999999-0000-0000-0000-000000000002', 2000);

-- Jobs 1-3 belong to the stranger and ran in the owner's structure 60000001.
-- Job 4 ran in a structure that is nobody's business here.
insert into public.character_industry_job_over_time values
  (1, '22222222-2222-2222-2222-222222222222', 60000001, 60000001, 34, 10, true),
  (2, '22222222-2222-2222-2222-222222222222', null,     60000001, 35, 20, true),
  (3, '22222222-2222-2222-2222-222222222222', 60000001, 60000001, 36, 30, true),
  (4, '22222222-2222-2222-2222-222222222222', 60000009, 60000009, 37, 40, true),
  -- A superseded version of job 1, pointing somewhere else: the function reads
  -- the live snapshot only, so this must never be what comes back.
  (1, '22222222-2222-2222-2222-222222222222', 60000099, 60000099, 34, 10, false);

-- A corp-installed job, taxed the same way.
insert into public.corp_industry_job_over_time values
  (5, 3000, 60000001, 60000001, 38, 50, true);

-- The owner's wallet: taxed for jobs 1 and 5. Job 2's tax went to corp 4000 —
-- neither account here belongs to it, so that entry entitles nobody in this
-- test. Job 3 produced a non-tax entry, and job 4 produced nothing at all.
insert into public.corp_wallet_journal values
  (1000, 1, 500001, 'industry_job_tax',  1, 'industry_job_id', 1000.00),
  (1000, 1, 500005, 'industry_job_tax',  5, 'industry_job_id', 5000.00),
  (4000, 1, 500002, 'industry_job_tax',  2, 'industry_job_id', 2000.00),
  (1000, 1, 500003, 'player_donation',   3, 'industry_job_id', 3000.00);

\i supabase/migrations/20260809000000_industry_job_tax_facility.sql

-- ── the owner ─────────────────────────────────────────────────────────────
set local test.uid = '99999999-0000-0000-0000-000000000001';

-- Taxed for job 1 → learns where it ran, even though the job is a stranger's
-- and no ordinary query would return it. This is the whole feature.
do $$
declare got record;
begin
  select * into got from public.industry_job_tax_facility(array[1]::bigint[]);
  assert got.job_id = 1, 'owner should resolve a job they were taxed for';
  assert got.station_id = 60000001, 'station_id should be the live row, got ' || coalesce(got.station_id::text, 'null');
  assert got.facility_id = 60000001, 'facility_id should be the live row';
end $$;

-- The superseded row for job 1 must not surface: exactly one row, and it is the
-- current one (60000001, not 60000099).
do $$
declare n int;
begin
  select count(*) into n from public.industry_job_tax_facility(array[1]::bigint[]);
  assert n = 1, 'expected one row per job, got ' || n;
  select count(*) into n from public.industry_job_tax_facility(array[1]::bigint[]) where station_id = 60000099;
  assert n = 0, 'superseded job versions must not be disclosed';
end $$;

-- Corp-installed jobs resolve through the same rule.
do $$
declare n int;
begin
  select count(*) into n from public.industry_job_tax_facility(array[5]::bigint[]) where facility_id = 60000001;
  assert n = 1, 'corp-installed taxed job should resolve';
end $$;

-- Everything the owner was NOT taxed for stays dark, including jobs that ran in
-- their own structure (2 and 3). Being the landlord is not the credential —
-- the tax payment is.
do $$
declare n int;
begin
  select count(*) into n from public.industry_job_tax_facility(array[2]::bigint[]);
  assert n = 0, 'a job whose tax went to another corp must not resolve';

  select count(*) into n from public.industry_job_tax_facility(array[3]::bigint[]);
  assert n = 0, 'a non-industry_job_tax journal entry must not resolve a job';

  select count(*) into n from public.industry_job_tax_facility(array[4]::bigint[]);
  assert n = 0, 'a job with no journal entry at all must not resolve';
end $$;

-- Asking for everything at once returns only the entitled subset, rather than
-- letting a wide array smuggle the rest through.
do $$
declare ids bigint[];
begin
  select array_agg(job_id order by job_id) into ids
    from public.industry_job_tax_facility(array[1, 2, 3, 4, 5]::bigint[]);
  assert ids = array[1, 5]::bigint[], 'bulk lookup should return only taxed jobs, got ' || coalesce(ids::text, 'null');
end $$;

-- ── the stranger ──────────────────────────────────────────────────────────
-- The job's own installer gets nothing from this function; it is not a general
-- lookup, and they were never taxed. Their own jobs reach them through RLS on
-- character_industry_job instead.
set local test.uid = '99999999-0000-0000-0000-000000000002';
do $$
declare n int;
begin
  select count(*) into n from public.industry_job_tax_facility(array[1, 2, 3, 4, 5]::bigint[]);
  assert n = 0, 'a caller with no matching tax entries must get nothing';
end $$;

-- ── anonymous ─────────────────────────────────────────────────────────────
-- auth.uid() null collapses the corp subselect to empty. The grant already
-- keeps anon out; this pins the belt-and-braces claim the migration comment
-- makes about the body being safe on its own.
set local test.uid = '';
do $$
declare n int;
begin
  select count(*) into n from public.industry_job_tax_facility(array[1, 2, 3, 4, 5]::bigint[]);
  assert n = 0, 'an unauthenticated caller must get nothing';
end $$;

-- ── the shape of what is disclosed ────────────────────────────────────────
-- Location only. If someone widens the return type to carry product_type_id,
-- runs, installer or cost, this fails and they have to come argue with the
-- sentence at the top of this file.
do $$
declare cols text;
begin
  select string_agg(p.name, ',' order by p.ord) into cols
  from unnest(
    (select proargnames from pg_proc where proname = 'industry_job_tax_facility'),
    (select proargmodes from pg_proc where proname = 'industry_job_tax_facility')
  ) with ordinality as p(name, mode, ord)
  where p.mode = 't';
  assert cols = 'job_id,station_id,facility_id',
    'industry_job_tax_facility must disclose location only, got ' || coalesce(cols, 'null');
end $$;

rollback;
