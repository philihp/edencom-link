-- SQL-level coverage for the fitting-share unification migration
-- (docs/sharing-layer/05-supersede-fittings.md): the per-level rows collapse
-- to one array-audience row per fit, membership pins the owner's affiliation
-- at migration time, unhonorable rows are deleted rather than widened, and
-- the rewritten fitting_shared_with_caller() matches on the arrays.
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

-- Stand-ins for what the migration and helpers read.
create table public.registration (
  id uuid primary key,
  user_id uuid,
  corporation_id bigint
);
create table public.corporation (
  corporation_id bigint primary key,
  alliance_id bigint
);
create table public.character_directory (
  registration_id uuid,
  corporation_id bigint,
  alliance_id bigint
);

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

-- The PRE-migration table shape, with the audience policy the migration drops
-- by name (body irrelevant here — only the drop must find it).
create table public.character_fitting_share (
  id uuid primary key default gen_random_uuid(),
  registration_id uuid not null references public.registration(id) on delete cascade,
  fitting_id bigint not null,
  level text not null check (level in ('corporation', 'alliance', 'public')),
  token text,
  created_at timestamptz not null default now()
);
create index character_fitting_share_fitting_idx on public.character_fitting_share (registration_id, fitting_id);
alter table public.character_fitting_share enable row level security;
create policy "Audience reads fitting shares aimed at them"
  on public.character_fitting_share for select using (true);

-- Fixtures: alice (corp 98001 / alliance 99001, in the directory) shares
-- fit 1 at corporation+public and fit 2 at alliance; bob has NO directory row
-- and shares fit 3 at corporation — unhonorable, must be deleted. dave is
-- alice's corp/alliance mate; carol is unaffiliated.
insert into public.corporation values (98001, 99001), (98002, null);
insert into public.registration values
  ('00000000-0000-0000-0000-0000000000aa', 'a0000000-0000-0000-0000-000000000000', 98001),
  ('00000000-0000-0000-0000-0000000000bb', 'b0000000-0000-0000-0000-000000000000', 98002),
  ('00000000-0000-0000-0000-0000000000cc', 'c0000000-0000-0000-0000-000000000000', null),
  ('00000000-0000-0000-0000-0000000000dd', 'd0000000-0000-0000-0000-000000000000', 98001);
insert into public.character_directory values
  ('00000000-0000-0000-0000-0000000000aa', 98001, 99001);
insert into public.character_fitting_share (registration_id, fitting_id, level) values
  ('00000000-0000-0000-0000-0000000000aa', 1, 'corporation'),
  ('00000000-0000-0000-0000-0000000000aa', 1, 'public'),
  ('00000000-0000-0000-0000-0000000000aa', 2, 'alliance'),
  ('00000000-0000-0000-0000-0000000000bb', 3, 'corporation');

\i supabase/migrations/20260805130000_fitting_share_unified.sql

do $$
declare
  corp_ids bigint[];
  ally_ids bigint[];
  n int;
begin
  -- Fit 1 collapsed to ONE row, and public dominates the corp level.
  select count(*), min(corporation_ids), min(alliance_ids)
    into n, corp_ids, ally_ids
    from public.character_fitting_share
    where registration_id = '00000000-0000-0000-0000-0000000000aa' and fitting_id = 1;
  assert n = 1, format('fit 1 collapses to one row, got %s', n);
  assert corp_ids = '{}' and ally_ids = '{}', 'public dominates the merged audiences';

  -- Fit 2 pinned alice's alliance at migration time.
  select min(alliance_ids) into ally_ids
    from public.character_fitting_share
    where registration_id = '00000000-0000-0000-0000-0000000000aa' and fitting_id = 2;
  assert ally_ids = '{99001}', 'alliance level pins the owner''s alliance id';

  -- Bob's unhonorable corp share (no directory row) was deleted, not widened.
  select count(*) into n from public.character_fitting_share
    where registration_id = '00000000-0000-0000-0000-0000000000bb';
  assert n = 0, 'unhonorable membership share is deleted';

  -- The rewritten helper matches on the arrays: dave (alliance-mate) sees
  -- fit 2, carol (unaffiliated) does not; everyone sees public fit 1.
  perform set_config('test.uid', 'd0000000-0000-0000-0000-000000000000', true);
  assert public.fitting_shared_with_caller('00000000-0000-0000-0000-0000000000aa', 2), 'alliance-mate matches the pinned alliance';
  assert public.fitting_shared_with_caller('00000000-0000-0000-0000-0000000000aa', 1), 'public fit matches a mate too';
  perform set_config('test.uid', 'c0000000-0000-0000-0000-000000000000', true);
  assert not public.fitting_shared_with_caller('00000000-0000-0000-0000-0000000000aa', 2), 'unaffiliated caller does not match the alliance share';
  assert public.fitting_shared_with_caller('00000000-0000-0000-0000-0000000000aa', 1), 'public fit matches anyone';

  -- The one-row identity is now a constraint.
  select count(*) into n from pg_constraint
    where conname = 'character_fitting_share_registration_fitting_key';
  assert n = 1, 'unique (registration_id, fitting_id) exists';
end $$;

rollback;
