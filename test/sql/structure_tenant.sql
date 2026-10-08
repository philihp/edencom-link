-- SQL-level coverage for structure_tenant and is_tenant_of() — the tenancy
-- fact behind the "people with jobs here" share audience
-- (docs/sharing-layer/12-structure-share.md, PR A).
--
-- Run against a THROWAWAY database from the repo root, so the \i below
-- resolves — same harness as asset_share.sql:
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

-- Stand-ins: the columns the migration's backfill and policies read.
create table public.registration (
  id uuid primary key,
  user_id uuid,
  corporation_id bigint
);
create table public.character_industry_job_over_time (
  id bigint generated always as identity primary key,
  registration_id uuid not null,
  station_id bigint,
  facility_id bigint,
  status text not null,
  is_current boolean not null default true,
  valid_until timestamptz not null default now()
);
create table public.corp_industry_job_over_time (
  id bigint generated always as identity primary key,
  corporation_id bigint not null,
  station_id bigint,
  facility_id bigint,
  status text not null,
  is_current boolean not null default true,
  valid_until timestamptz not null default now()
);

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

-- Fixtures the backfill will read. alice (aa) and bob (bb) are in corp 98001;
-- dave (dd) is unaffiliated. S1 and S2 are Upwell structures; 60003760 is Jita 4-4.
insert into public.registration values
  ('00000000-0000-0000-0000-0000000000aa', 'a0000000-0000-0000-0000-000000000000', 98001),
  ('00000000-0000-0000-0000-0000000000bb', 'b0000000-0000-0000-0000-000000000000', 98001),
  ('00000000-0000-0000-0000-0000000000dd', 'd0000000-0000-0000-0000-000000000000', null);
insert into public.character_industry_job_over_time (registration_id, station_id, facility_id, status, is_current, valid_until) values
  ('00000000-0000-0000-0000-0000000000aa', 1030000000001, 1030000000001, 'active',    true,  '2026-09-28 01:00+00'),
  ('00000000-0000-0000-0000-0000000000aa', 1030000000001, 1030000000001, 'ready',     true,  '2026-09-28 02:00+00'),
  ('00000000-0000-0000-0000-0000000000aa', 1030000000001, 1030000000001, 'delivered', true,  '2026-09-28 03:00+00'),
  ('00000000-0000-0000-0000-0000000000aa', 1030000000002, 1030000000002, 'active',    false, '2026-09-27 00:00+00'),
  ('00000000-0000-0000-0000-0000000000aa', 60003760,      60003760,      'active',    true,  '2026-09-28 04:00+00'),
  ('00000000-0000-0000-0000-0000000000dd', null,          1030000000002, 'paused',    true,  '2026-09-28 05:00+00');
insert into public.corp_industry_job_over_time (corporation_id, station_id, facility_id, status, is_current, valid_until) values
  (98001, 1030000000002, 1030000000002, 'active', true, '2026-09-28 06:00+00'),
  (98001, 1030000000001, 1030000000001, 'cancelled', true, '2026-09-28 06:00+00');

\i supabase/migrations/20260928023522_structure_tenant.sql
\i supabase/migrations/20261008050729_tenant_window.sql

do $$
declare
  n int;
  t timestamptz;
begin
  -- Backfill: alice has two open jobs at S1 (the delivered one and the NPC
  -- station do not count, nor the closed row at S2); dave one at S2 through
  -- facility_id alone; corp 98001 one at S2 (its cancelled job at S1 does not).
  select count(*) into n from public.structure_tenant;
  if n <> 3 then raise exception 'backfill rows: expected 3, got %', n; end if;
  select open_jobs, last_job_seen_at into n, t from public.structure_tenant
    where registration_id = '00000000-0000-0000-0000-0000000000aa' and structure_id = 1030000000001;
  if n <> 2 or t <> '2026-09-28 02:00+00' then raise exception 'alice@S1: expected 2 open, seen 02:00; got %, %', n, t; end if;
  select open_jobs into n from public.structure_tenant where corporation_id = 98001 and structure_id = 1030000000002;
  if n <> 1 then raise exception 'corp@S2: expected 1, got %', n; end if;
  select count(*) into n from public.structure_tenant where structure_id = 60003760;
  if n <> 0 then raise exception 'an NPC station was recorded as a structure'; end if;

  -- The extract's upsert lands on the generated-column primary key.
  insert into public.structure_tenant (registration_id, structure_id, open_jobs, last_job_seen_at)
    values ('00000000-0000-0000-0000-0000000000aa', 1030000000001, 5, now())
    on conflict (owner_key, structure_id) do update
      set open_jobs = excluded.open_jobs, last_job_seen_at = excluded.last_job_seen_at;
  select open_jobs into n from public.structure_tenant
    where registration_id = '00000000-0000-0000-0000-0000000000aa' and structure_id = 1030000000001;
  if n <> 5 then raise exception 'upsert did not update in place: %', n; end if;

  -- Exactly one owner key.
  begin
    insert into public.structure_tenant (registration_id, corporation_id, structure_id)
      values ('00000000-0000-0000-0000-0000000000aa', 98001, 1030000000009);
    raise exception 'a row with both owner keys was accepted';
  exception when check_violation then null;
  end;
  -- (No owner key leaves the generated owner_key null, so the primary key's
  -- not-null refuses it before the check does; either refusal is right.)
  begin
    insert into public.structure_tenant (structure_id) values (1030000000009);
    raise exception 'a row with no owner key was accepted';
  exception when check_violation or not_null_violation then null;
  end;

  -- RLS: own rows only. alice sees her row; bob (same corp, no jobs of his
  -- own) sees only the corporation's row; dave sees his own; nobody sees
  -- another person's.
  set local role authenticated;
  perform set_config('test.uid', 'a0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.structure_tenant;
  if n <> 2 then raise exception 'alice should see her row and her corp''s, saw %', n; end if;
  perform set_config('test.uid', 'b0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.structure_tenant;
  if n <> 1 then raise exception 'bob should see only the corp row, saw %', n; end if;
  select count(*) into n from public.structure_tenant where registration_id is not null;
  if n <> 0 then raise exception 'bob can see a personal row'; end if;
  perform set_config('test.uid', 'd0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.structure_tenant;
  if n <> 1 then raise exception 'dave should see his own row only, saw %', n; end if;
  perform set_config('test.uid', '', true);
  select count(*) into n from public.structure_tenant;
  if n <> 0 then raise exception 'a signed-out caller sees tenancy rows'; end if;

  -- is_tenant_of(): personally, through the corporation, and not at all.
  perform set_config('test.uid', 'a0000000-0000-0000-0000-000000000000', true);
  if not public.is_tenant_of(1030000000001) then raise exception 'alice is a tenant of S1'; end if;
  if not public.is_tenant_of(1030000000002) then raise exception 'alice is a tenant of S2 through her corp'; end if;
  if public.is_tenant_of(1030000000003) then raise exception 'alice is not a tenant of S3'; end if;
  perform set_config('test.uid', 'b0000000-0000-0000-0000-000000000000', true);
  if public.is_tenant_of(1030000000001) then raise exception 'bob is not a tenant of S1'; end if;
  if not public.is_tenant_of(1030000000002) then raise exception 'bob is a tenant of S2 through his corp'; end if;
  perform set_config('test.uid', 'd0000000-0000-0000-0000-000000000000', true);
  if not public.is_tenant_of(1030000000002) then raise exception 'dave is a tenant of S2'; end if;
  if public.is_tenant_of(1030000000001) then raise exception 'dave is not a tenant of S1'; end if;
  perform set_config('test.uid', '', true);
  if public.is_tenant_of(1030000000001) then raise exception 'a signed-out caller is nobody''s tenant'; end if;

  -- Tenancy is the last sighting within 30 days, not an open job: a zeroed
  -- row (the extract saw no open job any more) keeps alice a tenant while the
  -- stamp is fresh, and ends it once the stamp is older than 30 days — even
  -- with open_jobs still positive, since a row whose extract stopped
  -- reporting must age out too.
  reset role;
  update public.structure_tenant set open_jobs = 0, last_job_seen_at = now() - interval '29 days'
    where registration_id = '00000000-0000-0000-0000-0000000000aa' and structure_id = 1030000000001;
  set local role authenticated;
  perform set_config('test.uid', 'a0000000-0000-0000-0000-000000000000', true);
  if not public.is_tenant_of(1030000000001) then raise exception 'alice delivered her last S1 job 29 days ago and should still be a tenant'; end if;
  reset role;
  update public.structure_tenant set open_jobs = 3, last_job_seen_at = now() - interval '31 days'
    where registration_id = '00000000-0000-0000-0000-0000000000aa' and structure_id = 1030000000001;
  set local role authenticated;
  perform set_config('test.uid', 'a0000000-0000-0000-0000-000000000000', true);
  if public.is_tenant_of(1030000000001) then raise exception 'alice''s S1 row is 31 days stale and should no longer make her a tenant'; end if;
  reset role;

  raise notice 'structure_tenant: all assertions passed';
end $$;

rollback;
