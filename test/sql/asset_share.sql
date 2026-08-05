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

-- Stand-in for the asset SCD table phase 2's policy and walk read. Only the
-- columns asset_share_covers() touches, plus what the policy references.
create table public.character_asset_over_time (
  item_id bigint,
  registration_id uuid,
  location_id bigint,
  is_current boolean default true,
  valid_until timestamptz default now()
);

-- The is_current view, matching the real schema (phase 2 grants anon select
-- on it).
create view public.character_asset with (security_invoker = on) as
  select * from public.character_asset_over_time where is_current;
-- Grants that already exist in prod (schema.sql); the phase-2 migration only
-- adds the anon pair.
alter table public.character_asset_over_time enable row level security;
grant select on public.character_asset_over_time to authenticated;
grant select on public.character_asset           to authenticated;

-- The migrations under test: phase 1 (share table + audience helper), then
-- phase 2 (recursive widening policy + asset_share_covers).
\i supabase/migrations/20260805000000_character_asset_share.sql
\i supabase/migrations/20260805010000_asset_share_recursive_rls.sql

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

-- ── phase 2: asset_share_covers() recursion ─────────────────────────────────
-- Alice's hangar: container 100 holds 101 holds 102; sibling container 200
-- holds 201; and a 17-deep chain under 300 to probe the depth cap.
insert into public.character_asset_over_time (item_id, registration_id, location_id) values
  (100, '00000000-0000-0000-0000-0000000000aa', 60003760),
  (101, '00000000-0000-0000-0000-0000000000aa', 100),
  (102, '00000000-0000-0000-0000-0000000000aa', 101),
  (200, '00000000-0000-0000-0000-0000000000aa', 60003760),
  (201, '00000000-0000-0000-0000-0000000000aa', 200);
insert into public.character_asset_over_time (item_id, registration_id, location_id)
  select 300 + n, '00000000-0000-0000-0000-0000000000aa', case when n = 0 then 60003760 else 300 + n - 1 end
  from generate_series(0, 17) n;

-- Alice shares container 100 with bob's corp, and container 200 publicly.
insert into public.character_asset_share (id, registration_id, item_id, corporation_ids) values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000aa', 100, '{98002}');
insert into public.character_asset_share (id, registration_id, item_id) values
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000aa', 200);
insert into public.character_asset_share (id, registration_id, item_id) values
  ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-0000000000aa', 300);

do $$
begin
  -- Bob (corp 98002) sees the shared container and everything nested in it…
  perform set_config('test.uid', 'b0000000-0000-0000-0000-000000000000', true);
  assert public.asset_share_covers(100, '00000000-0000-0000-0000-0000000000aa'), 'shared container is covered';
  assert public.asset_share_covers(101, '00000000-0000-0000-0000-0000000000aa'), 'direct child is covered';
  assert public.asset_share_covers(102, '00000000-0000-0000-0000-0000000000aa'), 'grandchild is covered';
  -- …but not the sibling container by that grant (200 is covered by its own
  -- PUBLIC share — which is the composition the next assertion pins).
  assert public.asset_share_covers(200, '00000000-0000-0000-0000-0000000000aa'), 'public sibling is covered for bob too';

  -- Carol (no affiliations) gets only the public share's subtree.
  perform set_config('test.uid', 'c0000000-0000-0000-0000-000000000000', true);
  assert not public.asset_share_covers(102, '00000000-0000-0000-0000-0000000000aa'), 'corp-shared item hidden from an unaffiliated account';
  assert public.asset_share_covers(201, '00000000-0000-0000-0000-0000000000aa'), 'public share covers nested items';

  -- Anon rides the public share only.
  perform set_config('test.uid', '', true);
  assert public.asset_share_covers(201, '00000000-0000-0000-0000-0000000000aa'), 'anon sees inside the public container';
  assert not public.asset_share_covers(102, '00000000-0000-0000-0000-0000000000aa'), 'anon does not see the corp-shared container';

  -- The registration parameter scopes the share scan: the same item ids under
  -- a different grantor match nothing.
  perform set_config('test.uid', 'b0000000-0000-0000-0000-000000000000', true);
  assert not public.asset_share_covers(102, '00000000-0000-0000-0000-0000000000bb'), 'another grantor''s registration matches no shares';

  -- Depth cap 16 (matching asset_ancestors): 316 is 16 climbs from the shared
  -- root 300 and covered; 317 is 17 and not.
  perform set_config('test.uid', 'c0000000-0000-0000-0000-000000000000', true);
  assert public.asset_share_covers(316, '00000000-0000-0000-0000-0000000000aa'), 'item 16 levels under the shared root is covered';
  assert not public.asset_share_covers(317, '00000000-0000-0000-0000-0000000000aa'), 'depth cap stops the 17th level';
end $$;

-- Revoking the corp share closes access on the next check.
delete from public.character_asset_share where id = '10000000-0000-0000-0000-000000000001';
do $$
begin
  perform set_config('test.uid', 'b0000000-0000-0000-0000-000000000000', true);
  assert not public.asset_share_covers(102, '00000000-0000-0000-0000-0000000000aa'), 'revoked share no longer covers';
end $$;

-- Policy-level smoke as the authenticated role, RLS in force: the widening
-- policy fires without "infinite recursion detected in policy" (the definer's
-- whole purpose), and the select returns exactly the covered rows. After the
-- revoke above, the two public shares cover 200+201 and 300..316 = 19 of the
-- 23 fixture rows (100/101/102 unshared again, 317 past the depth cap).
set local role authenticated;
do $$
declare n int;
begin
  perform set_config('test.uid', 'b0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.character_asset;
  assert n = 19, format('grantee sees exactly the covered rows, got %s', n);
end $$;
reset role;

rollback;
