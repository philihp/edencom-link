-- SQL-level coverage for the open-registration stage 1 migration
-- (docs/open-registration.md): the "is this a real account?" predicate, the
-- three policies the anonymous-sign-in RLS audit tightened, the one-referral-
-- per-account index, and the sweep query behind the nightly anon-sweep job.
-- None of it is reachable from node:test — it is all Postgres, and two of the
-- four are security decisions.
--
-- Run against a THROWAWAY database (it creates stand-in tables, roles and an
-- `auth` schema) from the repo root, so the \i below resolves:
--
--   initdb -D /tmp/pg && pg_ctl -D /tmp/pg -o '-k /tmp -p 55432' start
--   createdb -h /tmp -p 55432 openreg
--   DATABASE_URL='postgresql://…/openreg' pnpm run test:sql
--
-- The migration is loaded by this script (not before it) because its SQL
-- functions are parsed at creation time and need the stand-ins to exist.
-- Everything runs in one transaction and rolls back; each check is an `assert`,
-- so psql exits non-zero on the first mismatch.
begin;

-- The Supabase roles, on a plain Postgres that has never heard of them.
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I', r);
    end if;
  end loop;
end $$;

create schema auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  is_anonymous boolean not null default false,
  created_at timestamptz not null default now()
);
create table auth.identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null
);

-- Stand-ins for Supabase's request-scoped claim helpers, driven by GUCs the
-- assertions below set.
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('test.uid', true), '')::uuid;
$$;
create function auth.jwt() returns jsonb language sql stable as $$
  select nullif(current_setting('test.jwt', true), '')::jsonb;
$$;

create table public.registration (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade
);
alter table public.registration enable row level security;
create policy "Users read own registrations" on public.registration for select to authenticated
  using (user_id = (select auth.uid()));
grant select on public.registration to authenticated;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid(), auth.jwt() to anon, authenticated, service_role;
create table public.gice_account (
  gice_id bigint primary key,
  user_id uuid not null unique references auth.users(id) on delete cascade
);
create table public.invite_code (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  created_by uuid references auth.users(id) on delete cascade,
  redeemed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  redeemed_at timestamptz,
  is_chancellor boolean not null default false
);
create table public.universe_name (id bigint primary key, name text not null);
create table public.character_affiliation (character_id bigint primary key, corporation_id bigint);
create table public.universe_structure (structure_id bigint primary key, name text);
alter table public.universe_name enable row level security;
alter table public.character_affiliation enable row level security;
alter table public.universe_structure enable row level security;
create policy "Authenticated read universe_name" on public.universe_name for select to authenticated using (true);
create policy "Authenticated read character_affiliation" on public.character_affiliation for select to authenticated using (true);
create policy "Authenticated read universe_structure" on public.universe_structure for select to authenticated using (true);
grant select on public.universe_name, public.character_affiliation, public.universe_structure to authenticated;

\i supabase/migrations/20260812000000_open_registration_anon.sql

-- ── fixtures ──────────────────────────────────────────────────────────────
-- drive-by: anonymous, nothing owned, old enough to sweep
insert into auth.users (id, is_anonymous, created_at)
  values ('00000000-0000-0000-0000-000000000001', true, now() - interval '40 days');
-- EVE-only: anonymous to Supabase, owns a character
insert into auth.users (id, is_anonymous, created_at)
  values ('00000000-0000-0000-0000-000000000002', true, now() - interval '40 days');
insert into public.registration (user_id) values ('00000000-0000-0000-0000-000000000002');
-- email account
insert into auth.users (id, is_anonymous, created_at)
  values ('00000000-0000-0000-0000-000000000003', false, now() - interval '40 days');
insert into auth.identities (user_id, provider) values ('00000000-0000-0000-0000-000000000003', 'email');
-- GICE-linked but still flagged anonymous (the stage-4 conversion shape)
insert into auth.users (id, is_anonymous, created_at)
  values ('00000000-0000-0000-0000-000000000004', true, now() - interval '40 days');
insert into public.gice_account (gice_id, user_id) values (7, '00000000-0000-0000-0000-000000000004');
-- fresh drive-by, inside the 30-day window
insert into auth.users (id, is_anonymous, created_at)
  values ('00000000-0000-0000-0000-000000000005', true, now() - interval '2 days');

-- ── is_established_account() ──────────────────────────────────────────────
set local test.jwt = '{"is_anonymous": true}';
set local test.uid = '00000000-0000-0000-0000-000000000001';
do $$ begin assert public.is_established_account() = false, 'drive-by should not be established'; end $$;

set local test.uid = '00000000-0000-0000-0000-000000000002';
do $$ begin assert public.is_established_account() = true, 'EVE-only account should be established'; end $$;

set local test.jwt = '{"is_anonymous": false}';
set local test.uid = '00000000-0000-0000-0000-000000000003';
do $$ begin assert public.is_established_account() = true, 'permanent account should be established'; end $$;

-- no request context at all (service role / cron)
set local test.jwt = '';
set local test.uid = '';
do $$ begin assert public.is_established_account() = true, 'no-JWT context should read as established'; end $$;

-- ── the tightened policies ────────────────────────────────────────────────
insert into public.universe_name values (30000142, 'Jita');
set local role authenticated;
set local test.jwt = '{"is_anonymous": true}';
set local test.uid = '00000000-0000-0000-0000-000000000001';
do $$
declare n int;
begin
  select count(*) into n from public.universe_name;
  assert n = 0, 'drive-by should read no universe_name rows';
end $$;
set local test.uid = '00000000-0000-0000-0000-000000000002';
do $$
declare n int;
begin
  select count(*) into n from public.universe_name;
  assert n = 1, 'EVE-only account should read universe_name';
end $$;
reset role;

-- ── one referral per account ──────────────────────────────────────────────
insert into public.invite_code (code) values ('aaaaaaaaaaaaaaaa'), ('bbbbbbbbbbbbbbbb');
update public.invite_code set redeemed_by = '00000000-0000-0000-0000-000000000001'
  where code = 'aaaaaaaaaaaaaaaa';
do $$
begin
  begin
    update public.invite_code set redeemed_by = '00000000-0000-0000-0000-000000000001'
      where code = 'bbbbbbbbbbbbbbbb';
    assert false, 'a second referral for one account should be rejected';
  exception when unique_violation then null;
  end;
end $$;
-- unredeemed codes stay freely duplicable
insert into public.invite_code (code) values ('cccccccccccccccc'), ('dddddddddddddddd');

-- ── the sweep ─────────────────────────────────────────────────────────────
do $$
declare ids uuid[];
begin
  select array_agg(u order by u) into ids from public.sweepable_anonymous_users() u;
  assert ids = array['00000000-0000-0000-0000-000000000001']::uuid[],
    format('unexpected sweep set: %s', ids);
end $$;

-- deleting the swept account returns its code to the pool
delete from auth.users where id = '00000000-0000-0000-0000-000000000001';
do $$
declare n int;
begin
  select count(*) into n from public.invite_code where code = 'aaaaaaaaaaaaaaaa' and redeemed_by is null;
  assert n = 1, 'sweeping an account should return its code to the pool';
end $$;

-- privileges: service role only
do $$
begin
  assert has_function_privilege('authenticated', 'public.sweepable_anonymous_users(interval, integer)', 'execute') = false,
    'authenticated must not execute the sweep query';
  assert has_function_privilege('service_role', 'public.sweepable_anonymous_users(interval, integer)', 'execute'),
    'service_role must execute the sweep query';
  assert has_function_privilege('authenticated', 'public.is_established_account()', 'execute'),
    'authenticated must execute is_established_account';
end $$;

\echo ALL ASSERTIONS PASSED
rollback;
