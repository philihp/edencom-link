-- SQL-level coverage for industry_job_hidden, the quiet per-job opt-out from
-- the co-tenant default (docs/sharing-layer/16-industry-job-share.md, PR 1):
-- a hidden job drops out of every co-tenant's read while its owner still sees
-- it, unhide restores it, only an owner may hide or unhide (any member, for a
-- corp job), and nothing a co-tenant can read says a job was hidden.
--
-- Run against a THROWAWAY database from the repo root, so the \i below
-- resolves — same harness as tenant_industry_jobs.sql:
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

-- What the tenant migration's structure_tax_revenue() needs to compile. The facility
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

-- Fixtures. alice (aa) is in corp 98001 and builds at S1; carol (cc) and erin
-- (ee) are corp 98002's members on two different accounts, carol building at
-- S1; bob (bb) is in corp 98001 with no job anywhere (a stranger to S1).
-- Job ids: 1xx alice, 2xx carol, 9xx corp 98002; 902 is a corp job carol
-- installed, so it sits in BOTH tables under one job_id.
insert into public.registration values
  ('00000000-0000-0000-0000-0000000000aa', 'a0000000-0000-0000-0000-000000000000', 98001),
  ('00000000-0000-0000-0000-0000000000bb', 'b0000000-0000-0000-0000-000000000000', 98001),
  ('00000000-0000-0000-0000-0000000000cc', 'c0000000-0000-0000-0000-000000000000', 98002),
  ('00000000-0000-0000-0000-0000000000ee', 'e0000000-0000-0000-0000-000000000000', 98002);
insert into public.character_industry_job_over_time (job_id, registration_id, station_id, facility_id, status, cost, is_current) values
  (101, '00000000-0000-0000-0000-0000000000aa', 1030000000001, 1030000000001, 'active', 1000, true),
  (201, '00000000-0000-0000-0000-0000000000cc', 1030000000001, 1030000000001, 'active', 2000, true),
  (202, '00000000-0000-0000-0000-0000000000cc', 1030000000001, 1030000000001, 'active', 2000, true),
  (902, '00000000-0000-0000-0000-0000000000cc', 1030000000001, 1030000000001, 'active', 9000, true);
insert into public.corp_industry_job_over_time (job_id, corporation_id, station_id, facility_id, status, cost, is_current) values
  (901, 98002, 1030000000001, 1030000000001, 'active', 9000, true),
  (902, 98002, 1030000000001, 1030000000001, 'active', 9000, true);

\i supabase/migrations/20260928023522_structure_tenant.sql
\i supabase/migrations/20261008005932_tenant_industry_jobs.sql
\i supabase/migrations/20261008050729_tenant_window.sql
\i supabase/migrations/20261016004245_industry_job_hidden.sql

do $$
declare
  n int;
  refused boolean;
  alice constant uuid := 'a0000000-0000-0000-0000-000000000000';
  bob   constant uuid := 'b0000000-0000-0000-0000-000000000000';
  carol constant uuid := 'c0000000-0000-0000-0000-000000000000';
  erin  constant uuid := 'e0000000-0000-0000-0000-000000000000';
  reg_aa constant uuid := '00000000-0000-0000-0000-0000000000aa';
  reg_cc constant uuid := '00000000-0000-0000-0000-0000000000cc';
  reg_ee constant uuid := '00000000-0000-0000-0000-0000000000ee';
begin
  set local role authenticated;

  -- Before anything is hidden, alice (a tenant of S1) reads carol's three
  -- current jobs and corp 98002's two.
  perform set_config('test.uid', alice::text, true);
  select count(*) into n from public.character_industry_job where registration_id = reg_cc;
  if n <> 3 then raise exception 'alice should see carol''s 3 jobs at S1 before any hide, saw %', n; end if;
  select count(*) into n from public.corp_industry_job;
  if n <> 2 then raise exception 'alice should see corp 98002''s 2 jobs at S1 before any hide, saw %', n; end if;

  -- carol hides 201: alice stops seeing it, carol still does.
  perform set_config('test.uid', carol::text, true);
  insert into public.industry_job_hidden (job_id, registration_id) values (201, reg_cc);
  select count(*) into n from public.character_industry_job where job_id = 201;
  if n <> 1 then raise exception 'carol must still see her own hidden job, saw % rows', n; end if;
  select count(*) into n from public.industry_job_hidden;
  if n <> 1 then raise exception 'carol should read her one hidden row, saw %', n; end if;

  perform set_config('test.uid', alice::text, true);
  select count(*) into n from public.character_industry_job where job_id = 201;
  if n <> 0 then raise exception 'carol hid 201, yet alice still sees it'; end if;
  select count(*) into n from public.character_industry_job_over_time where job_id = 201;
  if n <> 0 then raise exception 'a direct read of the table still shows alice the hidden job'; end if;
  select count(*) into n from public.character_industry_job where registration_id = reg_cc;
  if n <> 2 then raise exception 'alice should still see carol''s 2 other jobs, saw %', n; end if;
  -- Nothing alice can read says a job was hidden: not the hidden table, and
  -- no stand-in row in the job views.
  select count(*) into n from public.industry_job_hidden;
  if n <> 0 then raise exception 'alice reads % of carol''s hidden rows', n; end if;
  perform set_config('test.uid', bob::text, true);
  select count(*) into n from public.industry_job_hidden;
  if n <> 0 then raise exception 'bob reads % hidden rows', n; end if;

  -- The extract versions 201 (active → ready): still hidden, since the row is
  -- keyed on job_id rather than on a version.
  reset role;
  update public.character_industry_job_over_time set is_current = false, valid_until = now()
    where job_id = 201 and is_current;
  insert into public.character_industry_job_over_time (job_id, registration_id, station_id, facility_id, status, cost, is_current)
    values (201, reg_cc, 1030000000001, 1030000000001, 'ready', 2000, true);
  set local role authenticated;
  perform set_config('test.uid', alice::text, true);
  select count(*) into n from public.character_industry_job where job_id = 201;
  if n <> 0 then raise exception 'a new version of 201 came out from under the hide'; end if;
  perform set_config('test.uid', carol::text, true);
  select count(*) into n from public.character_industry_job where job_id = 201 and status = 'ready';
  if n <> 1 then raise exception 'carol should see the new version of her hidden job'; end if;

  -- Hides that must be refused. alice naming carol's job under carol's
  -- registration (not hers), under her own registration (the job is not hers,
  -- though the tenant policy lets her read it), or naming a job nobody has.
  perform set_config('test.uid', alice::text, true);
  begin
    insert into public.industry_job_hidden (job_id, registration_id) values (202, reg_cc);
    refused := false;
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then raise exception 'alice hid carol''s job under carol''s registration'; end if;
  begin
    insert into public.industry_job_hidden (job_id, registration_id) values (202, reg_aa);
    refused := false;
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then raise exception 'alice hid a co-tenant''s job she can read but does not own'; end if;
  begin
    insert into public.industry_job_hidden (job_id, registration_id) values (999, reg_aa);
    refused := false;
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then raise exception 'alice hid a job that does not exist'; end if;
  -- A character hide carries no hidden_by: the column is a corp job's audit.
  perform set_config('test.uid', carol::text, true);
  begin
    insert into public.industry_job_hidden (job_id, registration_id, hidden_by) values (202, reg_cc, reg_ee);
    refused := false;
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then raise exception 'a character hide was stamped with another account''s hidden_by'; end if;

  -- A stranger's delete of carol's hide touches nothing.
  perform set_config('test.uid', alice::text, true);
  delete from public.industry_job_hidden where job_id = 201;
  perform set_config('test.uid', carol::text, true);
  select count(*) into n from public.industry_job_hidden where job_id = 201;
  if n <> 1 then raise exception 'alice''s delete removed carol''s hide'; end if;

  -- carol unhides 201: alice reads it again on the next statement.
  delete from public.industry_job_hidden where job_id = 201;
  perform set_config('test.uid', alice::text, true);
  select count(*) into n from public.character_industry_job where job_id = 201;
  if n <> 1 then raise exception 'carol unhid 201, yet alice still does not see it'; end if;

  -- Corp jobs: any member hides, stamping one of their own registrations in
  -- the corporation as hidden_by.
  perform set_config('test.uid', carol::text, true);
  begin
    insert into public.industry_job_hidden (job_id, corporation_id) values (901, 98002);
    refused := false;
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then raise exception 'a corp hide with no hidden_by was accepted'; end if;
  begin
    insert into public.industry_job_hidden (job_id, corporation_id, hidden_by) values (901, 98002, reg_ee);
    refused := false;
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then raise exception 'carol stamped another account''s registration as hidden_by'; end if;
  insert into public.industry_job_hidden (job_id, corporation_id, hidden_by) values (901, 98002, reg_cc);
  select count(*) into n from public.corp_industry_job where job_id = 901;
  if n <> 1 then raise exception 'carol must still see her corp''s hidden job'; end if;

  perform set_config('test.uid', alice::text, true);
  select count(*) into n from public.corp_industry_job where job_id = 901;
  if n <> 0 then raise exception 'corp 98002 hid 901, yet alice still sees it'; end if;
  -- A non-member can neither hide a corp's job nor unhide it.
  begin
    insert into public.industry_job_hidden (job_id, corporation_id, hidden_by) values (902, 98002, reg_aa);
    refused := false;
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then raise exception 'alice hid a job of a corporation she is not in'; end if;
  delete from public.industry_job_hidden where job_id = 901;
  perform set_config('test.uid', erin::text, true);
  select count(*) into n from public.industry_job_hidden where job_id = 901;
  if n <> 1 then raise exception 'a non-member''s delete removed the corp''s hide'; end if;

  -- erin, the corp's other member on another account, reads carol's hide and
  -- lifts it.
  delete from public.industry_job_hidden where job_id = 901;
  perform set_config('test.uid', alice::text, true);
  select count(*) into n from public.corp_industry_job where job_id = 901;
  if n <> 1 then raise exception 'erin unhid 901, yet alice still does not see it'; end if;

  -- One job_id in both tables: one hide covers both.
  perform set_config('test.uid', carol::text, true);
  insert into public.industry_job_hidden (job_id, registration_id) values (902, reg_cc);
  perform set_config('test.uid', alice::text, true);
  select count(*) into n from public.character_industry_job where job_id = 902;
  if n <> 0 then raise exception 'the hidden 902 still shows on the character side'; end if;
  select count(*) into n from public.corp_industry_job where job_id = 902;
  if n <> 0 then raise exception 'the hidden 902 still shows on the corp side'; end if;
  -- ...and the corp's other member, an owner of the corp row, still sees it.
  perform set_config('test.uid', erin::text, true);
  select count(*) into n from public.corp_industry_job where job_id = 902;
  if n <> 1 then raise exception 'erin is an owner of corp job 902 and should still see it'; end if;

  -- Signed out: the hidden table reads as nothing.
  reset role;
  set local role anon;
  perform set_config('test.uid', '', true);
  begin
    select count(*) into n from public.industry_job_hidden;
    refused := false;
  exception when insufficient_privilege then refused := true;
  end;
  if not refused and n <> 0 then raise exception 'anon reads % hidden rows', n; end if;

  reset role;
  raise notice 'industry_job_hidden: all assertions passed';
end $$;

rollback;
