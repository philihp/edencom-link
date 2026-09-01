-- SQL-level coverage for refresh_asset_location_summary_cache() — the rollup
-- /asset reads instead of walking every container per render
-- (supabase/migrations/20260901031842_asset_location_summary_cache.sql).
--
-- This is in SQL rather than node:test because the whole thing is a recursive
-- query: what is worth pinning is that the walk rolls a nested item up to the
-- *root* location rather than to its immediate container, that it stops at an
-- account boundary, and that a rebuild replaces rather than accumulates. None
-- of that is observable from the TypeScript side, which only ever sees the
-- finished rows.
--
-- Run against a THROWAWAY database (it creates stand-in tables named after the
-- real ones in `public`) from the repo root:
--
--   initdb -D /tmp/pg && pg_ctl -D /tmp/pg -o '-k /tmp -p 55432' start
--   createdb -h /tmp -p 55432 alsc
--   DATABASE_URL='postgresql://…/alsc' pnpm run test:sql
--
-- Everything runs in one transaction and rolls back, so nothing is left behind.
begin;

-- Stand-ins carrying the columns the rollup touches. The real tables add the
-- SCD bookkeeping and foreign keys; none of it participates in the walk.
create table public.registration (
  id uuid primary key,
  user_id uuid not null,
  corporation_id bigint
);

create table public.character_asset_over_time (
  id bigint generated always as identity primary key,
  item_id bigint not null,
  registration_id uuid not null,
  location_id bigint,
  location_type text,
  is_current boolean not null default true,
  valid_until timestamptz not null default now()
);

create table public.corp_asset_over_time (
  id bigint generated always as identity primary key,
  item_id bigint not null,
  corporation_id bigint not null,
  location_id bigint,
  location_type text,
  is_current boolean not null default true,
  valid_until timestamptz not null default now()
);

create table public.asset_location_summary_cache (
  user_id       uuid   not null,
  owner_scope   text   not null check (owner_scope in ('character', 'corporation')),
  owner_id      text   not null,
  location_id   bigint not null,
  location_type text,
  stacks        bigint not null,
  refreshed_at  timestamptz not null default now(),
  primary key (user_id, owner_scope, owner_id, location_id)
);

-- The function under test, verbatim from the migration.
create or replace function public.refresh_asset_location_summary_cache(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_rows integer;
begin
  if p_user_id is null then
    return 0;
  end if;

  delete from public.asset_location_summary_cache where user_id = p_user_id;

  with recursive
  mine as (
    select id, corporation_id from public.registration where user_id = p_user_id
  ),
  char_visible as (
    select a.item_id, a.location_id, a.location_type, a.registration_id, a.is_current, a.valid_until
    from public.character_asset_over_time a
    where a.registration_id in (select id from mine)
  ),
  char_parent as (
    select distinct on (item_id) item_id, location_id, location_type
    from char_visible
    where item_id in (select location_id from char_visible where location_id is not null)
    order by item_id, is_current desc, valid_until desc
  ),
  char_walk as (
    select v.item_id as start_item, v.registration_id, v.location_id, v.location_type, 1 as depth
    from char_visible v
    where v.is_current
    union all
    select w.start_item, w.registration_id, p.location_id, p.location_type, w.depth + 1
    from char_walk w
    join char_parent p on p.item_id = w.location_id
    where w.depth < 64
  ),
  char_rows as (
    select 'character'::text as owner_scope,
           w.registration_id::text as owner_id,
           w.location_id,
           w.location_type,
           count(*) as stacks
    from char_walk w
    where w.location_id is not null
      and not exists (select 1 from char_parent o where o.item_id = w.location_id)
    group by w.registration_id, w.location_id, w.location_type
  ),
  corp_visible as (
    select a.item_id, a.location_id, a.location_type, a.corporation_id, a.is_current, a.valid_until
    from public.corp_asset_over_time a
    where a.corporation_id in (select corporation_id from mine where corporation_id is not null)
  ),
  corp_parent as (
    select distinct on (item_id) item_id, location_id, location_type
    from corp_visible
    where item_id in (select location_id from corp_visible where location_id is not null)
    order by item_id, is_current desc, valid_until desc
  ),
  corp_walk as (
    select v.item_id as start_item, v.corporation_id, v.location_id, v.location_type, 1 as depth
    from corp_visible v
    where v.is_current
    union all
    select w.start_item, w.corporation_id, p.location_id, p.location_type, w.depth + 1
    from corp_walk w
    join corp_parent p on p.item_id = w.location_id
    where w.depth < 64
  ),
  corp_rows as (
    select 'corporation'::text as owner_scope,
           w.corporation_id::text as owner_id,
           w.location_id,
           w.location_type,
           count(*) as stacks
    from corp_walk w
    where w.location_id is not null
      and not exists (select 1 from corp_parent o where o.item_id = w.location_id)
    group by w.corporation_id, w.location_id, w.location_type
  )
  insert into public.asset_location_summary_cache
    (user_id, owner_scope, owner_id, location_id, location_type, stacks)
  select p_user_id, owner_scope, owner_id, location_id, location_type, stacks
  from (select * from char_rows union all select * from corp_rows) r;

  get diagnostics v_rows = row_count;
  return v_rows;
end
$$;

\set alice   'aaaaaaaa-0000-0000-0000-000000000001'
\set bob     'bbbbbbbb-0000-0000-0000-000000000002'
\set reg_a1  '11111111-1111-1111-1111-111111111111'
\set reg_a2  '22222222-2222-2222-2222-222222222222'
\set reg_b1  '33333333-3333-3333-3333-333333333333'

-- Alice has two characters, one of them in corp 98000001. Bob is a separate
-- account entirely, in a corp of his own.
insert into public.registration (id, user_id, corporation_id) values
  (:'reg_a1', :'alice', 98000001),
  (:'reg_a2', :'alice', null),
  (:'reg_b1', :'bob',   98000002);

-- ── The nesting the walk exists for ──────────────────────────────────────
-- A station (60003760) holds a ship (900), the ship holds a container (901),
-- and the container holds two stacks (902, 903). Only the station is a root:
-- 900 and 901 are themselves items, so they are not locations in their own
-- right and every stack inside them must roll up to the station.
insert into public.character_asset_over_time (item_id, registration_id, location_id, location_type) values
  (900, :'reg_a1', 60003760, 'station'),
  (901, :'reg_a1', 900,      'item'),
  (902, :'reg_a1', 901,      'item'),
  (903, :'reg_a1', 901,      'item');

-- A second character with one item parked in a different station.
insert into public.character_asset_over_time (item_id, registration_id, location_id, location_type) values
  (910, :'reg_a2', 60003757, 'station');

-- Bob's items sit in the same station as Alice's, to prove the account boundary
-- holds when the *location* is shared.
insert into public.character_asset_over_time (item_id, registration_id, location_id, location_type) values
  (920, :'reg_b1', 60003760, 'station'),
  (921, :'reg_b1', 60003760, 'station');

-- Corp assets for Alice's corp, plus a corp Alice has no character in.
insert into public.corp_asset_over_time (item_id, corporation_id, location_id, location_type) values
  (930, 98000001, 60003760, 'station'),
  (940, 98000002, 60003760, 'station');

select public.refresh_asset_location_summary_cache(:'alice');

-- ── Everything rolls up to the root location ─────────────────────────────
-- Four items under reg_a1 all live at the station once the chain is walked:
-- the ship itself, the container, and the two stacks inside it. A summary that
-- bucketed by immediate container instead would report 900 and 901 as
-- locations of their own.
do $$
declare v_stacks bigint; v_locations int;
begin
  select stacks into v_stacks from public.asset_location_summary_cache
   where user_id = 'aaaaaaaa-0000-0000-0000-000000000001'
     and owner_scope = 'character'
     and owner_id = '11111111-1111-1111-1111-111111111111'
     and location_id = 60003760;
  if v_stacks is distinct from 4 then
    raise exception 'expected 4 stacks rolled up to the station, got %', v_stacks;
  end if;

  select count(distinct location_id) into v_locations
    from public.asset_location_summary_cache
   where user_id = 'aaaaaaaa-0000-0000-0000-000000000001'
     and owner_scope = 'character'
     and owner_id = '11111111-1111-1111-1111-111111111111';
  if v_locations <> 1 then
    raise exception 'a nested container became its own location (% distinct)', v_locations;
  end if;
end $$;

-- ── The account boundary ─────────────────────────────────────────────────
-- Bob shares a station with Alice, so his two items would land in the same
-- bucket if the rollup keyed on location rather than owner.
do $$
declare n int;
begin
  select count(*) into n from public.asset_location_summary_cache
   where user_id = 'aaaaaaaa-0000-0000-0000-000000000001'
     and owner_id = '33333333-3333-3333-3333-333333333333';
  if n <> 0 then
    raise exception 'another account''s rows leaked into this rollup';
  end if;

  select coalesce(sum(stacks), 0) into n from public.asset_location_summary_cache
   where user_id = 'aaaaaaaa-0000-0000-0000-000000000001' and owner_scope = 'character';
  if n <> 5 then
    raise exception 'expected 5 character stacks for the account (4 + 1), got %', n;
  end if;
end $$;

-- ── The corp half, and the corp boundary ─────────────────────────────────
-- Alice's corp contributes; the corp she has no character in does not.
do $$
declare n int; v_owner text;
begin
  select count(*) into n from public.asset_location_summary_cache
   where user_id = 'aaaaaaaa-0000-0000-0000-000000000001' and owner_scope = 'corporation';
  if n <> 1 then
    raise exception 'expected exactly one corporation bucket, got %', n;
  end if;

  select owner_id into v_owner from public.asset_location_summary_cache
   where user_id = 'aaaaaaaa-0000-0000-0000-000000000001' and owner_scope = 'corporation';
  if v_owner <> '98000001' then
    raise exception 'the wrong corporation is in the rollup: %', v_owner;
  end if;
end $$;

-- ── Closed rows are not current holdings ─────────────────────────────────
-- The walk seeds only from is_current rows, but reads *all* rows for parentage
-- so a container that dropped out of the snapshot can still be bridged.
-- Closing a leaf must drop it from the counts.
update public.character_asset_over_time set is_current = false where item_id = 903;
select public.refresh_asset_location_summary_cache(:'alice');

do $$
declare v_stacks bigint;
begin
  select stacks into v_stacks from public.asset_location_summary_cache
   where user_id = 'aaaaaaaa-0000-0000-0000-000000000001'
     and owner_id = '11111111-1111-1111-1111-111111111111';
  if v_stacks is distinct from 3 then
    raise exception 'a closed row still counts as a holding (got %)', v_stacks;
  end if;
end $$;

-- ── A rebuild replaces, it does not accumulate ───────────────────────────
-- The refresh deletes the account's rows before inserting. Running it twice
-- must be indistinguishable from running it once — otherwise every extract
-- cycle would double the reported stacks.
do $$
declare v_before int; v_after int; v_stacks_before bigint; v_stacks_after bigint;
begin
  select count(*), coalesce(sum(stacks), 0) into v_before, v_stacks_before
    from public.asset_location_summary_cache where user_id = 'aaaaaaaa-0000-0000-0000-000000000001';
  perform public.refresh_asset_location_summary_cache('aaaaaaaa-0000-0000-0000-000000000001');
  select count(*), coalesce(sum(stacks), 0) into v_after, v_stacks_after
    from public.asset_location_summary_cache where user_id = 'aaaaaaaa-0000-0000-0000-000000000001';
  if v_before <> v_after or v_stacks_before <> v_stacks_after then
    raise exception 'a rebuild changed the rollup: % rows/% stacks -> % rows/% stacks',
      v_before, v_stacks_before, v_after, v_stacks_after;
  end if;
end $$;

-- ── An account that owns nothing gets no rows, and that is not an error ──
do $$
declare n int;
begin
  n := public.refresh_asset_location_summary_cache('cccccccc-0000-0000-0000-000000000003');
  if n <> 0 then
    raise exception 'an account with no registrations built % rows', n;
  end if;
  if public.refresh_asset_location_summary_cache(null) <> 0 then
    raise exception 'a null account did not no-op';
  end if;
end $$;

-- ── Rebuilding one account leaves the others alone ───────────────────────
-- The delete is scoped by user_id; if it were not, one extract would blank
-- every other account's page until their own next run.
select public.refresh_asset_location_summary_cache(:'bob');
do $$
declare v_alice int; v_bob int;
begin
  select count(*) into v_alice from public.asset_location_summary_cache
   where user_id = 'aaaaaaaa-0000-0000-0000-000000000001';
  select count(*) into v_bob from public.asset_location_summary_cache
   where user_id = 'bbbbbbbb-0000-0000-0000-000000000002';
  if v_alice = 0 then
    raise exception 'rebuilding one account cleared another';
  end if;
  if v_bob = 0 then
    raise exception 'the second account built no rows';
  end if;
end $$;

rollback;
