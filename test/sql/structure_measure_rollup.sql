-- SQL-level coverage for the structure-measure rollup
-- (docs/structure-measure-rollup.md): the owner-only policy on
-- structure_measure_day, the owner-or-tenant policy on
-- structure_installer_day_all with the view's hidden_* masking, the
-- discovery RPC structure_measure_structure_ids(), and industry_index_at().
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

-- Stand-ins: the columns the migration's policies, view, functions and
-- indexes read.
create table public.registration (
  id uuid primary key,
  user_id uuid,
  corporation_id bigint
);
alter table public.registration enable row level security;
create policy "own registrations" on public.registration for select to authenticated
  using (user_id = (select auth.uid()));
grant select on public.registration to anon, authenticated;

create or replace function public.my_corporation_ids()
returns setof bigint
language sql
stable
as $$
  select r.corporation_id
  from public.registration r
  where r.user_id = (select auth.uid()) and r.corporation_id is not null;
$$;
grant execute on function public.my_corporation_ids() to authenticated;

-- Tenancy as a plain table of (registration, structure), stood in for the
-- 30-day window logic the real function carries.
create table public.structure_tenant (registration_id uuid, corporation_id bigint, structure_id bigint);
grant select on public.structure_tenant to authenticated;
create or replace function public.my_tenant_structure_ids()
returns setof bigint
language sql
stable
set search_path = public
as $$
  select t.structure_id from public.structure_tenant t
  where t.registration_id in (select id from public.registration where user_id = (select auth.uid()))
     or t.corporation_id in (select public.my_corporation_ids());
$$;
grant execute on function public.my_tenant_structure_ids() to authenticated;

create table public.industry_system_index (
  id bigint generated always as identity primary key,
  system_id bigint not null,
  activity text not null,
  cost_index real not null,
  recorded_at timestamptz not null default now()
);
create table public.corp_industry_job_over_time (
  id bigint generated always as identity primary key,
  installer_id bigint,
  start_date timestamptz,
  is_current boolean not null default true
);
create table public.corp_wallet_journal (
  entry_id bigint primary key,
  context_id bigint,
  ref_type text
);

\i supabase/migrations/20261030233521_structure_measure_rollup.sql

-- Fixtures. alice (aa, account a) is in corp 98001; bob (bb, account b) in
-- corp 98002 and a tenant of S1; dave (dd, account d) is unaffiliated. S1 and
-- S2 are Upwell structures; 60003760 is Jita 4-4.
insert into public.registration values
  ('00000000-0000-0000-0000-0000000000aa', 'a0000000-0000-0000-0000-000000000000', 98001),
  ('00000000-0000-0000-0000-0000000000bb', 'b0000000-0000-0000-0000-000000000000', 98002),
  ('00000000-0000-0000-0000-0000000000dd', 'd0000000-0000-0000-0000-000000000000', null);
insert into public.structure_tenant values ('00000000-0000-0000-0000-0000000000bb', null, 1030000000001);

insert into public.structure_measure_day (structure_id, registration_id, corporation_id, utc_day, jobs, eiv_jobs, revenue) values
  (1030000000001, '00000000-0000-0000-0000-0000000000aa', null, '2026-10-05', 1, 0, 0),
  (1030000000001, null, 98001, '2026-10-05', 1, 0, 100),
  -- A corp job alice installed: filed under her registration as EIV only.
  (1030000000002, '00000000-0000-0000-0000-0000000000aa', null, '2026-10-06', 0, 1, 0),
  -- Revenue alone names a structure, but never discovers one.
  (1030000000003, null, 98001, '2026-10-06', 0, 0, 50),
  -- A station is nobody's structure.
  (60003760, '00000000-0000-0000-0000-0000000000aa', null, '2026-10-06', 1, 0, 0),
  (1030000000002, '00000000-0000-0000-0000-0000000000bb', null, '2026-10-05', 1, 0, 0),
  (1030000000002, null, 98002, '2026-10-05', 1, 0, 0);

insert into public.structure_installer_day_all (structure_id, registration_id, corporation_id, utc_day, character_id, jobs, hidden_jobs, hidden_installer_ids) values
  (1030000000001, '00000000-0000-0000-0000-0000000000aa', null, '2026-10-05', 90000001, 2, 1, '{}'),
  (1030000000001, null, 98002, '2026-10-05', null, 1, 2, '{90000002}'),
  (1030000000002, null, 98001, '2026-10-05', null, 1, 0, '{}');

insert into public.industry_system_index (system_id, activity, cost_index, recorded_at) values
  (30000142, 'manufacturing', 0.03, '2026-10-01 00:00+00'),
  (30000142, 'manufacturing', 0.05, '2026-10-05 00:00+00'),
  (30000142, 'reaction',      0.01, '2026-10-05 00:00+00');

do $$
declare
  n int;
  ids bigint[];
  answers jsonb;
begin
  -- The extract's upsert lands on the generated-column primary key.
  insert into public.structure_measure_day (structure_id, registration_id, utc_day, jobs)
    values (1030000000001, '00000000-0000-0000-0000-0000000000aa', '2026-10-05', 7)
    on conflict (structure_id, owner_key, utc_day) do update set jobs = excluded.jobs;
  select jobs into n from public.structure_measure_day
    where registration_id = '00000000-0000-0000-0000-0000000000aa' and structure_id = 1030000000001;
  if n <> 7 then raise exception 'upsert did not update in place: %', n; end if;

  -- Exactly one owner key.
  begin
    insert into public.structure_measure_day (structure_id, registration_id, corporation_id, utc_day)
      values (1030000000009, '00000000-0000-0000-0000-0000000000aa', 98001, '2026-10-05');
    raise exception 'a row with both owner keys was accepted';
  exception when check_violation then null;
  end;

  -- ── structure_measure_day: own rows only ──
  set local role authenticated;
  perform set_config('test.uid', 'a0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.structure_measure_day;
  if n <> 5 then raise exception 'alice should see her 3 rows and her corp''s 2, saw %', n; end if;
  select count(*) into n from public.structure_measure_day where corporation_id = 98002 or registration_id = '00000000-0000-0000-0000-0000000000bb';
  if n <> 0 then raise exception 'alice can see bob''s rows'; end if;
  perform set_config('test.uid', 'b0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.structure_measure_day;
  if n <> 2 then raise exception 'bob should see his row and his corp''s, saw %', n; end if;
  perform set_config('test.uid', 'd0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.structure_measure_day;
  if n <> 0 then raise exception 'dave should see nothing, saw %', n; end if;
  perform set_config('test.uid', '', true);
  select count(*) into n from public.structure_measure_day;
  if n <> 0 then raise exception 'a signed-out caller sees measure rows'; end if;

  -- ── structure_measure_structure_ids(): our jobs discover, revenue and stations do not ──
  perform set_config('test.uid', 'a0000000-0000-0000-0000-000000000000', true);
  select array_agg(s order by s) into ids from public.structure_measure_structure_ids() s;
  if ids <> array[1030000000001, 1030000000002]::bigint[] then
    raise exception 'alice should discover S1 (her job) and S2 (her corp-installed EIV), got %', ids;
  end if;
  perform set_config('test.uid', 'd0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.structure_measure_structure_ids();
  if n <> 0 then raise exception 'dave discovers structures'; end if;

  -- ── structure_installer_day: owner or tenant, hidden_* for the owner only ──
  perform set_config('test.uid', 'a0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.structure_installer_day;
  if n <> 2 then raise exception 'alice should see her row and her corp''s, saw %', n; end if;
  select hidden_jobs into n from public.structure_installer_day where registration_id = '00000000-0000-0000-0000-0000000000aa';
  if n <> 1 then raise exception 'alice''s own hidden jobs should show, got %', n; end if;
  select count(*) into n from public.structure_installer_day where corporation_id = 98002;
  if n <> 0 then raise exception 'alice is no tenant of S1 and no member of 98002, yet sees its row'; end if;

  perform set_config('test.uid', 'b0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.structure_installer_day;
  if n <> 2 then raise exception 'bob should see alice''s S1 row (tenant) and his corp''s, saw %', n; end if;
  select hidden_jobs into n from public.structure_installer_day where registration_id = '00000000-0000-0000-0000-0000000000aa';
  if n <> 0 then raise exception 'a tenant can see another owner''s hidden jobs: %', n; end if;
  select hidden_jobs into n from public.structure_installer_day where corporation_id = 98002;
  if n <> 2 then raise exception 'bob''s own corp''s hidden jobs should show, got %', n; end if;
  select hidden_installer_ids into ids from public.structure_installer_day where corporation_id = 98002;
  if ids <> array[90000002]::bigint[] then raise exception 'bob''s own corp''s hidden installers should show, got %', ids; end if;
  select count(*) into n from public.structure_installer_day where structure_id = 1030000000002 and corporation_id = 98001;
  if n <> 0 then raise exception 'bob is no tenant of S2, yet sees 98001''s row there'; end if;

  perform set_config('test.uid', 'd0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.structure_installer_day;
  if n <> 0 then raise exception 'dave should see nothing on the tab, saw %', n; end if;
  perform set_config('test.uid', '', true);
  select count(*) into n from public.structure_installer_day;
  if n <> 0 then raise exception 'a signed-out caller sees installer rows'; end if;

  -- ── industry_index_at(): latest at or before, else earliest after, else null ──
  reset role;
  select public.industry_index_at('[
    {"key": "at",     "system_id": 30000142, "activity": "manufacturing", "as_of": "2026-10-05T00:00:00Z"},
    {"key": "before", "system_id": 30000142, "activity": "manufacturing", "as_of": "2026-10-03T12:00:00Z"},
    {"key": "early",  "system_id": 30000142, "activity": "manufacturing", "as_of": "2026-09-01T00:00:00Z"},
    {"key": "none",   "system_id": 30000142, "activity": "copying",       "as_of": "2026-10-05T00:00:00Z"}
  ]'::jsonb) into answers;
  if abs((select (a ->> 'cost_index')::real from jsonb_array_elements(answers) a where a ->> 'key' = 'at') - 0.05) > 1e-6
    then raise exception 'at: expected the sample at that moment, got %', answers; end if;
  if abs((select (a ->> 'cost_index')::real from jsonb_array_elements(answers) a where a ->> 'key' = 'before') - 0.03) > 1e-6
    then raise exception 'before: expected the latest earlier sample, got %', answers; end if;
  if (select a ->> 'exact' from jsonb_array_elements(answers) a where a ->> 'key' = 'before') <> 'true'
    then raise exception 'before: should be exact'; end if;
  if abs((select (a ->> 'cost_index')::real from jsonb_array_elements(answers) a where a ->> 'key' = 'early') - 0.03) > 1e-6
    then raise exception 'early: expected the earliest later sample, got %', answers; end if;
  if (select a ->> 'exact' from jsonb_array_elements(answers) a where a ->> 'key' = 'early') <> 'false'
    then raise exception 'early: should not be exact'; end if;
  if (select a -> 'cost_index' from jsonb_array_elements(answers) a where a ->> 'key' = 'none') <> 'null'::jsonb
    then raise exception 'none: expected null, got %', answers; end if;
end $$;

rollback;
