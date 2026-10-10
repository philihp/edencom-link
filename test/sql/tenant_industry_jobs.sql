-- SQL-level coverage for the tenant policies on the two industry-job tables,
-- the cost masking in their views, and structure_tax_revenue()'s explicit
-- ownership test (docs/sharing-layer/13-industry-job-share.md, shipped without
-- an opt-in on 2026-10-08).
--
-- Run against a THROWAWAY database from the repo root, so the \i below
-- resolves — same harness as structure_tenant.sql:
--
--   DATABASE_URL='postgresql://…/throwaway' pnpm run test:sql
--
-- Everything runs inside one transaction and rolls back.
begin;

do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin; exception when duplicate_object then null; end $$;

create schema if not exists auth;
create or replace function auth.uid() returns uuid
language sql stable
as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;

-- Stand-ins. The job tables carry every column the views list, since the
-- migration replaces the views with an explicit column list.
create table public.registration (
  id uuid primary key,
  user_id uuid,
  corporation_id bigint
);
alter table public.registration enable row level security;
create policy "own registrations" on public.registration for select to authenticated
  using (user_id = (select auth.uid()));
grant select on public.registration to anon, authenticated;

-- `id` is added AFTER creation, as production got it (migration
-- 20260713140000 `alter table … add column id`), so it is the last column and
-- the `select *` views below carry it last — the shape that made a
-- `create or replace view` spelling schema.sql's order fail on 2026-10-08.
create table public.character_industry_job_over_time (
  job_id bigint not null,
  registration_id uuid not null,
  installer_id bigint not null default 0,
  facility_id bigint not null,
  station_id bigint,
  activity_id smallint not null default 1,
  blueprint_id bigint not null default 0,
  blueprint_type_id bigint not null default 0,
  blueprint_location_id bigint not null default 0,
  output_location_id bigint not null default 0,
  product_type_id bigint,
  runs integer not null default 1,
  cost numeric(20, 2),
  licensed_runs integer,
  probability real,
  status text not null,
  duration integer not null default 0,
  start_date timestamptz not null default now(),
  end_date timestamptz not null default now(),
  pause_date timestamptz,
  completed_date timestamptz,
  completed_character_id bigint,
  successful_runs integer,
  is_current boolean not null default true,
  valid_from timestamptz not null default now(),
  valid_until timestamptz not null default now()
);
alter table public.character_industry_job_over_time add column id bigint generated always as identity primary key;
alter table public.character_industry_job_over_time enable row level security;
create policy "Users read own industry jobs" on public.character_industry_job_over_time
  for select to authenticated
  using (registration_id in (select id from public.registration where user_id = (select auth.uid())));
create view public.character_industry_job with (security_invoker = on) as
  select * from public.character_industry_job_over_time where is_current;
grant select on public.character_industry_job_over_time to authenticated;
grant select on public.character_industry_job to authenticated;

create table public.corp_industry_job_over_time (
  job_id bigint not null,
  corporation_id bigint not null,
  installer_id bigint not null default 0,
  facility_id bigint not null,
  station_id bigint,
  activity_id smallint not null default 1,
  blueprint_id bigint not null default 0,
  blueprint_type_id bigint not null default 0,
  blueprint_location_id bigint not null default 0,
  output_location_id bigint not null default 0,
  product_type_id bigint,
  runs integer not null default 1,
  cost numeric(20, 2),
  licensed_runs integer,
  probability real,
  status text not null,
  duration integer not null default 0,
  start_date timestamptz not null default now(),
  end_date timestamptz not null default now(),
  pause_date timestamptz,
  completed_date timestamptz,
  completed_character_id bigint,
  successful_runs integer,
  is_current boolean not null default true,
  valid_from timestamptz not null default now(),
  valid_until timestamptz not null default now()
);
alter table public.corp_industry_job_over_time add column id bigint generated always as identity primary key;
alter table public.corp_industry_job_over_time enable row level security;
create policy "Users read industry jobs for own corps" on public.corp_industry_job_over_time
  for select to authenticated
  using (corporation_id in (select corporation_id from public.registration where user_id = (select auth.uid()) and corporation_id is not null));
create view public.corp_industry_job with (security_invoker = on) as
  select * from public.corp_industry_job_over_time where is_current;
grant select on public.corp_industry_job_over_time to authenticated;
grant select on public.corp_industry_job to authenticated;

create or replace function public.my_corporation_ids()
returns setof bigint
language sql
stable
as $$
  select r.corporation_id
  from public.registration r
  where r.user_id = (select auth.uid()) and r.corporation_id is not null;
$$;

-- What structure_tax_revenue() reads besides the job views. The facility
-- resolver stand-in answers from both tables with no RLS, as the real
-- SECURITY DEFINER one does (it discloses only a location).
create table public.corp_wallet_journal (
  corporation_id bigint,
  first_party_id bigint,
  date timestamptz,
  amount numeric,
  ref_type text,
  context_id bigint
);
alter table public.corp_wallet_journal enable row level security;
create policy "own corp journal" on public.corp_wallet_journal for select to authenticated
  using (corporation_id in (select public.my_corporation_ids()));
grant select on public.corp_wallet_journal to authenticated;
create table public.corp_structure (structure_id bigint primary key, corporation_id bigint);
alter table public.corp_structure enable row level security;
create policy "own corp structures" on public.corp_structure for select to authenticated
  using (corporation_id in (select public.my_corporation_ids()));
grant select on public.corp_structure to authenticated;
create or replace function public.industry_job_tax_facility(job_ids bigint[])
returns table (job_id bigint, station_id bigint, facility_id bigint)
language sql stable security definer
as $$
  select job_id, station_id, facility_id from public.character_industry_job_over_time
  where job_id = any(job_ids) and is_current
  union
  select job_id, station_id, facility_id from public.corp_industry_job_over_time
  where job_id = any(job_ids) and is_current;
$$;

-- Fixtures. alice (aa) and bob (bb) are in corp 98001, which owns S1; carol
-- (cc) is in corp 98002 and builds at S1 as a tenant; dave (dd) builds at S2
-- only. Job ids: 1xx alice, 2xx carol, 3xx dave, 9xx corp 98002.
insert into public.registration values
  ('00000000-0000-0000-0000-0000000000aa', 'a0000000-0000-0000-0000-000000000000', 98001),
  ('00000000-0000-0000-0000-0000000000bb', 'b0000000-0000-0000-0000-000000000000', 98001),
  ('00000000-0000-0000-0000-0000000000cc', 'c0000000-0000-0000-0000-000000000000', 98002),
  ('00000000-0000-0000-0000-0000000000dd', 'd0000000-0000-0000-0000-000000000000', null);
insert into public.character_industry_job_over_time (job_id, registration_id, station_id, facility_id, status, cost, is_current) values
  (101, '00000000-0000-0000-0000-0000000000aa', 1030000000001, 1030000000001, 'active',    1000, true),
  (102, '00000000-0000-0000-0000-0000000000aa', 1030000000001, 1030000000001, 'delivered', 1000, true),
  (103, '00000000-0000-0000-0000-0000000000aa', 1030000000001, 1030000000001, 'active',    1000, false),
  (201, '00000000-0000-0000-0000-0000000000cc', 1030000000001, 1030000000001, 'active',    2000, true),
  (202, '00000000-0000-0000-0000-0000000000cc', 1030000000001, 1030000000001, 'delivered', 2000, true),
  (203, '00000000-0000-0000-0000-0000000000cc', 1030000000001, 1030000000001, 'active',    2000, false),
  (204, '00000000-0000-0000-0000-0000000000cc', 60003760,      60003760,      'active',    2000, true),
  (301, '00000000-0000-0000-0000-0000000000dd', null,          1030000000002, 'active',    3000, true);
insert into public.corp_industry_job_over_time (job_id, corporation_id, station_id, facility_id, status, cost, is_current) values
  (901, 98002, 1030000000001, 1030000000001, 'active', 9000, true),
  (902, 98002, 1030000000002, 1030000000002, 'active', 9000, true);
insert into public.corp_structure values (1030000000001, 98001);
-- Receipts in corp 98001's wallet at S1: one for alice's job (own rate), one
-- for carol's (revenue), one for corp 98002's job (revenue).
insert into public.corp_wallet_journal values
  (98001, 2000000001, '2026-10-01 00:00+00', 100, 'industry_job_tax', 101),
  (98001, 2000000003, '2026-10-01 00:00+00', 200, 'industry_job_tax', 201),
  (98001, 98002,      '2026-10-01 00:00+00', 900, 'industry_job_tax', 901);

\i supabase/migrations/20260928023522_structure_tenant.sql
\i supabase/migrations/20261008005932_tenant_industry_jobs.sql
\i supabase/migrations/20261008050729_tenant_window.sql

do $$
declare
  n int;
  c numeric;
  own_rate numeric;
  revenue numeric;
begin
  set local role authenticated;

  -- alice is a tenant of S1, so she reads carol's and corp 98002's CURRENT jobs
  -- there — not carol's history row, not carol's Jita job, and nothing at S2.
  perform set_config('test.uid', 'a0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.character_industry_job;
  if n <> 4 then raise exception 'alice should see her 2 current jobs and carol''s 2 at S1, saw %', n; end if;
  select count(*) into n from public.character_industry_job where job_id in (203, 204, 301);
  if n <> 0 then raise exception 'alice reads a history row, an NPC-station job, or a job at a structure she is not in'; end if;
  select count(*) into n from public.character_industry_job_over_time where not is_current and registration_id <> '00000000-0000-0000-0000-0000000000aa';
  if n <> 0 then raise exception 'history crossed accounts on the table'; end if;
  select count(*) into n from public.corp_industry_job;
  if n <> 1 then raise exception 'alice should see corp 98002''s job at S1 only, saw %', n; end if;

  -- cost: hers in the clear, carol's and the other corp's blanked.
  select cost into c from public.character_industry_job where job_id = 101;
  if c is distinct from 1000 then raise exception 'alice''s own cost should be visible, got %', c; end if;
  select cost into c from public.character_industry_job where job_id = 201;
  if c is not null then raise exception 'carol''s cost leaked to alice: %', c; end if;
  select cost into c from public.corp_industry_job where job_id = 901;
  if c is not null then raise exception 'corp 98002''s cost leaked to alice: %', c; end if;

  -- bob holds no job of his own, but his corp owns S1 and has no job there, so
  -- he is no tenant: nothing but what his own policies showed before.
  perform set_config('test.uid', 'b0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.character_industry_job;
  if n <> 0 then raise exception 'bob is not a tenant anywhere yet sees % jobs', n; end if;

  -- carol reads alice's current rows at S1, and corp 98002's at S2 as her own
  -- corp's — dave's job at S2 too, since her corp builds there.
  perform set_config('test.uid', 'c0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.character_industry_job where registration_id = '00000000-0000-0000-0000-0000000000aa';
  if n <> 2 then raise exception 'carol should see alice''s 2 current jobs at S1, saw %', n; end if;
  select count(*) into n from public.character_industry_job where job_id = 301;
  if n <> 1 then raise exception 'carol''s corp builds at S2, so dave''s job there should be visible'; end if;
  select cost into c from public.corp_industry_job where job_id = 901;
  if c is distinct from 9000 then raise exception 'carol''s own corp''s cost should be visible, got %', c; end if;

  -- dave reads corp 98002's job at S2 and nothing at S1.
  perform set_config('test.uid', 'd0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.corp_industry_job;
  if n <> 1 then raise exception 'dave should see the one corp job at S2, saw %', n; end if;
  select count(*) into n from public.character_industry_job where job_id < 300;
  if n <> 0 then raise exception 'dave sees jobs at S1, where he does not build'; end if;

  -- Signed out: nothing.
  perform set_config('test.uid', '', true);
  select count(*) into n from public.character_industry_job;
  if n <> 0 then raise exception 'a signed-out caller sees % jobs', n; end if;

  -- structure_tax_revenue(): alice's corp owns S1. Alice's own job's receipt is
  -- the own-rate charge; carol's and corp 98002's receipts are revenue, even
  -- though alice can now see those jobs.
  perform set_config('test.uid', 'a0000000-0000-0000-0000-000000000000', true);
  select coalesce(sum(isk_self_paid), 0), coalesce(sum(isk), 0) into own_rate, revenue
    from public.structure_tax_revenue(1030000000001, '2026-09-01 00:00+00');
  if own_rate <> 100 then raise exception 'own-rate charges at S1 should be alice''s 100, got %', own_rate; end if;
  if revenue <> 1200 then raise exception 'incoming tax at S1 should total 1200, got %', revenue; end if;

  -- 30 days after alice's last job at S1 (the stamp the extract leaves), she
  -- sees nothing of anyone else's there — only her own rows — whatever
  -- open_jobs still says.
  reset role;
  update public.structure_tenant set last_job_seen_at = now() - interval '31 days'
    where registration_id = '00000000-0000-0000-0000-0000000000aa' and structure_id = 1030000000001;
  set local role authenticated;
  perform set_config('test.uid', 'a0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.character_industry_job where registration_id <> '00000000-0000-0000-0000-0000000000aa';
  if n <> 0 then raise exception 'alice''s S1 tenancy is 31 days stale yet she still sees % foreign jobs', n; end if;
  select count(*) into n from public.corp_industry_job;
  if n <> 0 then raise exception 'alice''s S1 tenancy is 31 days stale yet she still sees % corp jobs', n; end if;
  select count(*) into n from public.character_industry_job;
  if n <> 2 then raise exception 'alice should still see her own 2 current jobs, saw %', n; end if;
  -- Carol, still fresh at S1, still reads alice's rows: the window is per tenant.
  perform set_config('test.uid', 'c0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.character_industry_job where registration_id = '00000000-0000-0000-0000-0000000000aa';
  if n <> 2 then raise exception 'carol is still a tenant of S1 and should still see alice''s jobs, saw %', n; end if;

  reset role;
  raise notice 'tenant_industry_jobs: all assertions passed';
end $$;

rollback;
