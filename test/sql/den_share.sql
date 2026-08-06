-- SQL-level coverage for the den-share unification migration
-- (docs/sharing-layer/06-supersede-mercenary-dens.md): the per-(registration,
-- alliance) rows collapse to one array-audience row per registration, and the
-- rewritten mercenary_den_shared_with_caller() matches through the shared
-- audience matcher — with no empty-audience (accidentally public) rows.
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
create table public.corporation (
  corporation_id bigint primary key,
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

-- The shared matcher the migration's rewritten helper delegates to (created by
-- the fitting_share_unified migration in prod).
create or replace function public.share_audience_matches(
  corporation_ids bigint[], alliance_ids bigint[], secret text
)
returns boolean
language sql
stable
as $$
  select
    (secret is null and corporation_ids = '{}' and alliance_ids = '{}')
    or corporation_ids && array(select public.my_corporation_ids())
    or alliance_ids && array(select public.my_alliance_ids());
$$;

-- The PRE-migration table shape, with the audience policy the migration drops
-- by name.
create table public.character_mercenary_den_share (
  registration_id uuid not null references public.registration(id) on delete cascade,
  alliance_id bigint not null,
  created_at timestamptz not null default now(),
  primary key (registration_id, alliance_id)
);
create index character_mercenary_den_share_alliance_id_idx
  on public.character_mercenary_den_share (alliance_id);
alter table public.character_mercenary_den_share enable row level security;
create policy "Alliance members read shares to their alliances"
  on public.character_mercenary_den_share for select using (true);

-- Fixtures: alice shares with alliances 99001+99002 (two rows → one array);
-- bob shares with 99002 only. dave is in 99001, carol unaffiliated.
insert into public.corporation values (98001, 99001), (98002, 99002);
insert into public.registration values
  ('00000000-0000-0000-0000-0000000000aa', 'a0000000-0000-0000-0000-000000000000', 98001),
  ('00000000-0000-0000-0000-0000000000bb', 'b0000000-0000-0000-0000-000000000000', 98002),
  ('00000000-0000-0000-0000-0000000000cc', 'c0000000-0000-0000-0000-000000000000', null),
  ('00000000-0000-0000-0000-0000000000dd', 'd0000000-0000-0000-0000-000000000000', 98001);
insert into public.character_mercenary_den_share (registration_id, alliance_id) values
  ('00000000-0000-0000-0000-0000000000aa', 99001),
  ('00000000-0000-0000-0000-0000000000aa', 99002),
  ('00000000-0000-0000-0000-0000000000bb', 99002);

\i supabase/migrations/20260806000000_den_share_unified.sql

do $$
declare
  ally_ids bigint[];
  n int;
begin
  -- Alice's two rows collapsed to one carrying both alliances.
  select count(*), min(alliance_ids) into n, ally_ids
    from public.character_mercenary_den_share
    where registration_id = '00000000-0000-0000-0000-0000000000aa';
  assert n = 1, format('alice collapses to one row, got %s', n);
  assert ally_ids @> '{99001,99002}' and array_length(ally_ids, 1) = 2, 'both alliances aggregated';

  -- No empty-audience (accidentally public) rows exist anywhere.
  select count(*) into n from public.character_mercenary_den_share
    where corporation_ids = '{}' and alliance_ids = '{}' and secret is null;
  assert n = 0, 'no row collapsed to an empty (public) audience';

  -- The rewritten helper: dave (alliance 99001) sees alice's dens but not
  -- bob's; carol sees neither.
  perform set_config('test.uid', 'd0000000-0000-0000-0000-000000000000', true);
  assert public.mercenary_den_shared_with_caller('00000000-0000-0000-0000-0000000000aa'), 'alliance-mate matches';
  assert not public.mercenary_den_shared_with_caller('00000000-0000-0000-0000-0000000000bb'), 'other alliance does not match';
  perform set_config('test.uid', 'c0000000-0000-0000-0000-000000000000', true);
  assert not public.mercenary_den_shared_with_caller('00000000-0000-0000-0000-0000000000aa'), 'unaffiliated caller matches nothing';

  -- One row per registration is now a constraint.
  select count(*) into n from pg_constraint
    where conname = 'character_mercenary_den_share_registration_key';
  assert n = 1, 'unique (registration_id) exists';
end $$;

rollback;
