-- SQL-level coverage for asset_share_matches_caller() — the audience-match
-- helper behind the asset share's RLS (docs/sharing-layer/01-asset-share-table.md).
--
-- Run against a THROWAWAY database (it creates stand-in tables, Supabase roles
-- and a stub auth.uid() in `public`/`auth`) from the repo root, so the \i below
-- resolves — same harness as blueprint_search.sql:
--
--   DATABASE_URL='postgresql://…/throwaway' pnpm run test:sql
--
-- The migration is loaded by this script (not before it) because its policies
-- and FK need the stand-ins to exist first. Everything runs inside one
-- transaction and rolls back — role/schema DDL included.
begin;

-- The Supabase roles the migration grants to / creates policies for.
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin; exception when duplicate_object then null; end $$;

-- Stub auth.uid(): reads the caller uuid from a transaction-local setting so
-- each assertion below can impersonate a different account.
create schema if not exists auth;
create or replace function auth.uid() returns uuid
language sql stable
as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;

-- Stand-ins for the tables the helpers read. Column types match the real
-- schema; registration needs its pk for the share table's FK.
create table public.registration (
  id uuid primary key,
  user_id uuid,
  corporation_id bigint
);
create table public.corporation (
  corporation_id bigint primary key,
  alliance_id bigint
);

-- The real membership helpers, verbatim from the den-share migration.
create or replace function public.my_corporation_ids()
returns setof bigint
language sql
stable
as $$
  select r.corporation_id
  from public.registration r
  where r.user_id = (select auth.uid()) and r.corporation_id is not null;
$$;

create or replace function public.my_alliance_ids()
returns setof bigint
language sql
stable
as $$
  select c.alliance_id
  from public.registration r
  join public.corporation c on c.corporation_id = r.corporation_id
  where r.user_id = (select auth.uid()) and c.alliance_id is not null;
$$;

-- The migration under test.
\i supabase/migrations/20260805000000_character_asset_share.sql

-- Fixtures: alice in corp 98001 (alliance 99001), bob in corp 98002
-- (alliance 99002), carol registered with no corp.
insert into public.corporation values (98001, 99001), (98002, 99002);
insert into public.registration values
  ('00000000-0000-0000-0000-0000000000aa', 'a0000000-0000-0000-0000-000000000000', 98001),
  ('00000000-0000-0000-0000-0000000000bb', 'b0000000-0000-0000-0000-000000000000', 98002),
  ('00000000-0000-0000-0000-0000000000cc', 'c0000000-0000-0000-0000-000000000000', null);

do $$
begin
  -- ── (d) fully public: names no one, matches everyone — even anon ─────────
  perform set_config('test.uid', 'b0000000-0000-0000-0000-000000000000', true);
  assert public.asset_share_matches_caller('{}', '{}', null), 'public share matches a member';
  perform set_config('test.uid', 'c0000000-0000-0000-0000-000000000000', true);
  assert public.asset_share_matches_caller('{}', '{}', null), 'public share matches an unaffiliated account';
  perform set_config('test.uid', '', true);
  assert public.asset_share_matches_caller('{}', '{}', null), 'public share matches anon';

  -- ── (a) corporation list ─────────────────────────────────────────────────
  perform set_config('test.uid', 'b0000000-0000-0000-0000-000000000000', true);
  assert public.asset_share_matches_caller('{98002}', '{}', null), 'corp member matches a listed corp';
  assert not public.asset_share_matches_caller('{98001}', '{}', null), 'other corp does not match';
  perform set_config('test.uid', 'c0000000-0000-0000-0000-000000000000', true);
  assert not public.asset_share_matches_caller('{98001,98002}', '{}', null), 'no corp, no match';

  -- ── (b) alliance list ────────────────────────────────────────────────────
  perform set_config('test.uid', 'b0000000-0000-0000-0000-000000000000', true);
  assert public.asset_share_matches_caller('{}', '{99002}', null), 'alliance member matches a listed alliance';
  assert not public.asset_share_matches_caller('{}', '{99001}', null), 'other alliance does not match';

  -- ── audiences compose: any grant path suffices ───────────────────────────
  assert public.asset_share_matches_caller('{98001}', '{99002}', null), 'alliance grant works alongside a foreign corp list';

  -- ── (c) link-only: invisible to RLS, even for a matching-looking caller ──
  assert not public.asset_share_matches_caller('{}', '{}', 'deadbeef'), 'link-only share matches no one';
  perform set_config('test.uid', '', true);
  assert not public.asset_share_matches_caller('{}', '{}', 'deadbeef'), 'link-only share does not match anon';

  -- ── a secret on a membership share does not disable the membership path ──
  perform set_config('test.uid', 'b0000000-0000-0000-0000-000000000000', true);
  assert public.asset_share_matches_caller('{98002}', '{}', 'deadbeef'), 'corp grant still matches when a link also exists';
end $$;

rollback;
