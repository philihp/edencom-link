-- SQL-level coverage for one holder per item id across both hangar tables
-- (supabase/migrations/20261101065555_asset_claim_cross_hangar.sql,
-- docs/ship-memory.md "One holder per item id"): character_asset_claim()
-- closes an incoming item's open corp row, and corp_asset_claim() an
-- incoming item's open character row, on the run's clock.
--
-- asset_handoff_claim.sql covers the handoff inside one table, where the
-- partial unique index backs the claim up. No index spans the two tables, so
-- here the claim is the only thing standing between an item and two holders.
--
-- Run against a THROWAWAY database from the repo root, like the other suites:
--
--   DATABASE_URL='postgresql://…/throwaway' pnpm run test:sql
--
-- Everything runs in one transaction and rolls back.
begin;

do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin; exception when duplicate_object then null; end $$;

-- Stand-ins carrying the columns the claims touch, with each table's one
-- uniqueness rule. The real tables (schema.sql) add foreign keys, RLS and the
-- views; none of those take part in the claim.
create table public.character_asset_version (
  id bigint generated always as identity primary key,
  item_id bigint not null,
  registration_id uuid not null,
  type_id bigint not null,
  location_id bigint,
  location_flag text,
  location_type text,
  quantity bigint,
  is_singleton boolean,
  is_blueprint_copy boolean,
  is_current boolean not null default true,
  valid_from timestamptz not null default now(),
  valid_until timestamptz not null default now(),
  name text
);
create unique index character_asset_version_current_item_idx
  on public.character_asset_version (item_id) where is_current;
create table public.character_asset_location (
  asset_id bigint primary key references public.character_asset_version (id) on delete cascade,
  registration_id uuid not null,
  location_id bigint not null,
  location_flag text,
  location_type text
);

create table public.corp_asset_version (
  id bigint generated always as identity primary key,
  item_id bigint not null,
  corporation_id bigint not null,
  type_id bigint not null,
  location_id bigint,
  location_flag text,
  location_type text,
  quantity bigint,
  is_singleton boolean,
  is_blueprint_copy boolean,
  is_current boolean not null default true,
  valid_from timestamptz not null default now(),
  valid_until timestamptz not null default now()
);
create unique index corp_asset_version_current_item_idx
  on public.corp_asset_version (item_id) where is_current;
create table public.corp_asset_location (
  asset_id bigint primary key references public.corp_asset_version (id) on delete cascade,
  corporation_id bigint not null,
  location_id bigint not null,
  location_flag text,
  location_type text
);

\i supabase/migrations/20261101065555_asset_claim_cross_hangar.sql

-- Fixtures. Alice's character holds Rifter 5001 at Jita 4-4 with a module
-- 5002 fitted, and a can 5003 she keeps. Corp 98001 holds Wreathe 6001 at the
-- same station, and Office 1001 its hangar items sit in.
insert into public.character_asset_version
  (item_id, registration_id, type_id, location_id, location_flag, location_type, quantity, is_singleton, valid_until) values
  (5001, '00000000-0000-0000-0000-0000000000aa', 587, null, null, null, 1, true, '2026-11-01T00:00:00Z'),
  (5002, '00000000-0000-0000-0000-0000000000aa', 2873, 5001, 'HiSlot0', 'item', 1, true, '2026-11-01T00:00:00Z'),
  (5003, '00000000-0000-0000-0000-0000000000aa', 3467, null, null, null, 1, true, '2026-11-01T00:00:00Z');
insert into public.character_asset_location (asset_id, registration_id, location_id, location_flag, location_type)
  select id, registration_id, 60003760, 'Hangar', 'station'
    from public.character_asset_version where item_id in (5001, 5003);
insert into public.corp_asset_version
  (item_id, corporation_id, type_id, location_id, location_flag, location_type, quantity, is_singleton, valid_until) values
  (1001, 98001, 27, null, null, null, 1, true, '2026-11-01T00:00:00Z'),
  (6001, 98001, 653, 1001, 'CorpSAG1', 'item', 1, true, '2026-11-01T00:00:00Z');
insert into public.corp_asset_location (asset_id, corporation_id, location_id, location_flag, location_type)
  select id, corporation_id, 60003760, 'OfficeFolder', 'station'
    from public.corp_asset_version where item_id = 1001;

-- ── character → corp ──────────────────────────────────────────────────────
-- Alice gives the Rifter to the corp, fit and all. The corp's run lists the
-- hull and its module in a hangar division; the character's run, which would
-- have closed them, is hours away.
select public.corp_asset_claim(jsonb_build_array(
  jsonb_build_object('item_id', 5001, 'corporation_id', 98001, 'type_id', 587,
    'location_id', 1001, 'location_flag', 'CorpSAG2', 'location_type', 'item',
    'quantity', 1, 'is_singleton', true, 'valid_until', '2026-11-01T06:00:00Z'),
  jsonb_build_object('item_id', 5002, 'corporation_id', 98001, 'type_id', 2873,
    'location_id', 5001, 'location_flag', 'HiSlot0', 'location_type', 'item',
    'quantity', 1, 'is_singleton', true, 'valid_until', '2026-11-01T06:00:00Z')
));

do $$
begin
  assert (select count(*) from public.character_asset_version where item_id in (5001, 5002) and is_current) = 0,
    'the character still holds the hull or its module after the corp claimed them';
  assert (select count(*) from public.corp_asset_version where item_id in (5001, 5002) and is_current) = 2,
    'the corp does not hold the hull and its module';
  assert (select bool_and(valid_until = '2026-11-01T06:00:00Z')
            from public.character_asset_version where item_id in (5001, 5002) and not is_current),
    'the character''s rows did not close on the corp run''s clock';
  assert (select count(*) from public.character_asset_version where item_id = 5003 and is_current) = 1,
    'an item the corp never listed was closed';
  assert (select count(*) from public.character_asset_location l
            join public.character_asset_version v on v.id = l.asset_id where v.item_id = 5001) = 1,
    'the closed hull lost its place: the character''s history of where it sat';
  assert (select location_id from public.corp_asset_version where item_id = 5002 and is_current) = 5001,
    'the module is not a parent link to the hull in its new hangar';
end $$;

-- ── corp → character ──────────────────────────────────────────────────────
-- A director takes the Wreathe out of the corp hangar into her own. Her run
-- lists it at the station; the corp's run is hours away.
select public.character_asset_claim(jsonb_build_array(
  jsonb_build_object('item_id', 6001, 'registration_id', '00000000-0000-0000-0000-0000000000aa', 'type_id', 653,
    'location_id', 60003760, 'location_flag', 'Hangar', 'location_type', 'station',
    'quantity', 1, 'is_singleton', true, 'valid_until', '2026-11-01T07:00:00Z', 'name', 'Kettle')
));

do $$
begin
  assert (select count(*) from public.corp_asset_version where item_id = 6001 and is_current) = 0,
    'the corp still holds the hull after the character claimed it';
  assert (select count(*) from public.character_asset_version where item_id = 6001 and is_current) = 1,
    'the character does not hold the hull';
  assert (select valid_until from public.corp_asset_version where item_id = 6001 and not is_current) = '2026-11-01T07:00:00Z',
    'the corp''s row did not close on the character run''s clock';
  assert (select count(*) from public.corp_asset_version where item_id in (1001, 5001, 5002) and is_current) = 3,
    'a corp item the character never listed was closed';
  assert (select l.location_id from public.character_asset_location l
            join public.character_asset_version v on v.id = l.asset_id
           where v.item_id = 6001 and v.is_current) = 60003760,
    'the hull''s station did not move to the character''s place table';
end $$;

-- ── and back ──────────────────────────────────────────────────────────────
-- An item can cross more than once; each crossing leaves one holder and keeps
-- every earlier version.
select public.corp_asset_claim(jsonb_build_array(
  jsonb_build_object('item_id', 6001, 'corporation_id', 98001, 'type_id', 653,
    'location_id', 1001, 'location_flag', 'CorpSAG1', 'location_type', 'item',
    'quantity', 1, 'is_singleton', true, 'valid_until', '2026-11-01T08:00:00Z')
));

do $$
begin
  assert (select count(*) from public.character_asset_version where item_id = 6001 and is_current)
       + (select count(*) from public.corp_asset_version where item_id = 6001 and is_current) = 1,
    'an item crossing back left other than one holder';
  assert (select count(*) from public.character_asset_version where item_id = 6001)
       + (select count(*) from public.corp_asset_version where item_id = 6001) = 3,
    'a crossing lost a version';
end $$;

-- ── the lock order ────────────────────────────────────────────────────────
-- Concurrency cannot be raced inside one session, so this checks what the
-- deadlock-freedom rests on: both bodies take both locks, the character lock
-- first.
do $$
declare
  f text;
  def text;
  char_at int;
  corp_at int;
begin
  foreach f in array array['character_asset_claim', 'corp_asset_claim'] loop
    def := pg_get_functiondef(('public.' || f || '(jsonb)')::regprocedure);
    char_at := strpos(def, 'pg_advisory_xact_lock(hashtext(''public.character_asset_over_time'')');
    corp_at := strpos(def, 'pg_advisory_xact_lock(hashtext(''public.corp_asset_over_time'')');
    assert char_at > 0 and corp_at > 0, f || ' does not take both advisory locks';
    assert char_at < corp_at, f || ' takes the corp lock before the character lock';
  end loop;
end $$;

rollback;
