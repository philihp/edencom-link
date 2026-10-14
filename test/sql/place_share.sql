-- SQL-level coverage for place shares (docs/sharing-layer/15-place-share.md):
-- a character_asset_share / corp_asset_share row whose item_id names a station,
-- structure or system covers the GRANTOR's roots there and everything inside
-- them — never another owner's items at the same place, not even an alt's on
-- the same account — and lets the recipient read the place of exactly those
-- roots. An item share keeps hiding its root's place.
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
-- The real table carries an owner policy; the stand-in is open, which only
-- matters for my_*_ids(), whose own predicate does the scoping.
grant select on public.registration to anon, authenticated;
grant select on public.corporation to anon, authenticated;
grant usage on schema auth to anon, authenticated;
grant usage on schema public to anon, authenticated;

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

create or replace function public.asset_share_matches_caller(
  corporation_ids bigint[], alliance_ids bigint[], secret text
)
returns boolean
language sql
stable
as $$
  select public.share_audience_matches(corporation_ids, alliance_ids, secret);
$$;
grant execute on function public.share_audience_matches(bigint[], bigint[], text) to anon, authenticated;
grant execute on function public.asset_share_matches_caller(bigint[], bigint[], text) to anon, authenticated;

-- ── the character hangar, copied from schema.sql ───────────────────────────
create table public.character_asset_version (
  id bigint generated always as identity primary key,
  item_id bigint not null,
  registration_id uuid not null references public.registration (id),
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
alter table public.character_asset_version enable row level security;
create policy "Users read own assets"
  on public.character_asset_version
  for select
  to authenticated
  using (registration_id in (select id from public.registration where user_id = (select auth.uid())));
grant select on public.character_asset_version to anon, authenticated;

create table public.character_asset_location (
  asset_id bigint primary key references public.character_asset_version (id) on delete cascade,
  registration_id uuid not null references public.registration (id),
  location_id bigint not null,
  location_flag text,
  location_type text
);
alter table public.character_asset_location enable row level security;
create policy "Users read own asset locations"
  on public.character_asset_location
  for select
  to authenticated
  using (registration_id in (select id from public.registration where user_id = (select auth.uid())));
grant select on public.character_asset_location to anon, authenticated;

create view public.character_asset_over_time with (security_invoker = on) as
  select v.id, v.item_id, v.registration_id, v.type_id,
         v.location_id, v.location_flag, v.location_type,
         v.quantity, v.is_singleton, v.is_blueprint_copy, v.is_current, v.valid_from, v.valid_until, v.name
  from public.character_asset_version v
  where v.location_id is not null
    and exists (select 1 from public.character_asset_version p where p.item_id = v.location_id and p.is_current)
  union all
  select v.id, v.item_id, v.registration_id, v.type_id,
         null::bigint, null::text, null::text,
         v.quantity, v.is_singleton, v.is_blueprint_copy, v.is_current, v.valid_from, v.valid_until, v.name
  from public.character_asset_version v
  where v.location_id is not null
    and not exists (select 1 from public.character_asset_version p where p.item_id = v.location_id and p.is_current)
  union all
  select v.id, v.item_id, v.registration_id, v.type_id,
         l.location_id, l.location_flag, l.location_type,
         v.quantity, v.is_singleton, v.is_blueprint_copy, v.is_current, v.valid_from, v.valid_until, v.name
  from public.character_asset_version v
  left join public.character_asset_location l on l.asset_id = v.id
  where v.location_id is null;

create view public.character_asset with (security_invoker = on) as
  select * from public.character_asset_over_time where is_current;
grant select on public.character_asset_over_time to anon, authenticated;
grant select on public.character_asset           to anon, authenticated;

-- The character share table and its two read policies, from schema.sql.
create table public.character_asset_share (
  id uuid primary key default gen_random_uuid(),
  registration_id uuid not null references public.registration (id),
  item_id bigint not null,
  corporation_ids bigint[] not null default '{}',
  alliance_ids bigint[] not null default '{}',
  secret text,
  created_at timestamptz not null default now(),
  show_as_main boolean not null default false,
  unique (registration_id, item_id)
);
alter table public.character_asset_share enable row level security;
create policy "Users read own asset shares"
  on public.character_asset_share
  for select
  to authenticated
  using (registration_id in (select id from public.registration where user_id = (select auth.uid())));
create policy "Audience reads asset shares aimed at them"
  on public.character_asset_share
  for select
  to anon, authenticated
  using (public.asset_share_matches_caller(corporation_ids, alliance_ids, secret));
grant select on public.character_asset_share to anon, authenticated;

-- ── the corp hangar, copied from schema.sql ────────────────────────────────
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
create unique index corp_asset_version_current_item_idx on public.corp_asset_version (item_id) where is_current;
alter table public.corp_asset_version enable row level security;
create policy "Users read assets for own corps"
  on public.corp_asset_version
  for select
  to authenticated
  using (corporation_id in (select public.my_corporation_ids()));
grant select on public.corp_asset_version to authenticated;

create table public.corp_asset_location (
  asset_id bigint primary key references public.corp_asset_version (id) on delete cascade,
  corporation_id bigint not null,
  location_id bigint not null,
  location_flag text,
  location_type text
);
alter table public.corp_asset_location enable row level security;
create policy "Users read asset locations for own corps"
  on public.corp_asset_location
  for select
  to authenticated
  using (corporation_id in (select public.my_corporation_ids()));
grant select on public.corp_asset_location to anon, authenticated;

create view public.corp_asset_over_time with (security_invoker = on) as
  select v.id, v.item_id, v.corporation_id, v.type_id,
         v.location_id, v.location_flag, v.location_type,
         v.quantity, v.is_singleton, v.is_blueprint_copy, v.is_current, v.valid_from, v.valid_until
  from public.corp_asset_version v
  where v.location_id is not null
    and exists (select 1 from public.corp_asset_version p where p.item_id = v.location_id and p.is_current)
  union all
  select v.id, v.item_id, v.corporation_id, v.type_id,
         null::bigint, null::text, null::text,
         v.quantity, v.is_singleton, v.is_blueprint_copy, v.is_current, v.valid_from, v.valid_until
  from public.corp_asset_version v
  where v.location_id is not null
    and not exists (select 1 from public.corp_asset_version p where p.item_id = v.location_id and p.is_current)
  union all
  select v.id, v.item_id, v.corporation_id, v.type_id,
         l.location_id, l.location_flag, l.location_type,
         v.quantity, v.is_singleton, v.is_blueprint_copy, v.is_current, v.valid_from, v.valid_until
  from public.corp_asset_version v
  left join public.corp_asset_location l on l.asset_id = v.id
  where v.location_id is null;

create view public.corp_asset with (security_invoker = on) as
  select * from public.corp_asset_over_time where is_current;
grant select on public.corp_asset_over_time to anon, authenticated;
grant select on public.corp_asset           to anon, authenticated;

-- PR 2 and PR 3 of the corp share, then the migration under test.
\i supabase/migrations/20261013062951_corp_asset_share.sql
\i supabase/migrations/20261013064401_corp_asset_share_recursive_rls.sql
\i supabase/migrations/20261014161500_asset_place_share.sql
-- Account-wide: a character place share covers the whole account's items there.
\i supabase/migrations/20261014174504_account_wide_place_share.sql

-- The character widening policy, created once asset_share_covers() exists.
create policy "Audience reads shared assets"
  on public.character_asset_version
  for select
  to anon, authenticated
  using (is_current and public.asset_share_covers(item_id, registration_id));

-- The hotfix gates that policy behind asset_sharing_registration_ids() and
-- recreates it, so it comes after the policy it replaces.
\i supabase/migrations/20261014192421_asset_share_covers_gated.sql

-- Fixtures. Alice's ACCOUNT holds two characters in corp 98001 (alliance
-- 99001): a1 and her alt a2. Bob is in 98002 (alliance 99002); carol is
-- unaffiliated. P is a player structure none of them own; S is a station.
insert into public.corporation values (98001, 99001), (98002, 99002);
insert into public.registration values
  ('00000000-0000-0000-0000-0000000000a1', 'a0000000-0000-0000-0000-000000000000', 98001),
  ('00000000-0000-0000-0000-0000000000a2', 'a0000000-0000-0000-0000-000000000000', 98001),
  ('00000000-0000-0000-0000-0000000000bb', 'b0000000-0000-0000-0000-000000000000', 98002),
  ('00000000-0000-0000-0000-0000000000cc', 'c0000000-0000-0000-0000-000000000000', null);

-- Character items. a1 at P: ship 10 holding 11 holding 12, and can 20 heading
-- a 16-deep chain 101..116 for the depth cap. a1 at S: 30. a2 at P: 40 (holding
-- 41). Bob at P: 50.
insert into public.character_asset_version (item_id, registration_id, type_id, location_id) values
  (10, '00000000-0000-0000-0000-0000000000a1', 587, null),
  (11, '00000000-0000-0000-0000-0000000000a1', 3651, 10),
  (12, '00000000-0000-0000-0000-0000000000a1', 34, 11),
  (20, '00000000-0000-0000-0000-0000000000a1', 17363, null),
  (30, '00000000-0000-0000-0000-0000000000a1', 34, null),
  (40, '00000000-0000-0000-0000-0000000000a2', 587, null),
  (41, '00000000-0000-0000-0000-0000000000a2', 34, 40),
  (50, '00000000-0000-0000-0000-0000000000bb', 34, null);
insert into public.character_asset_version (item_id, registration_id, type_id, location_id)
  select 100 + n, '00000000-0000-0000-0000-0000000000a1', 17363, case when n = 1 then 20 else 100 + n - 1 end
  from generate_series(1, 16) n;
insert into public.character_asset_location (asset_id, registration_id, location_id, location_type, location_flag)
  select v.id, v.registration_id,
         case when v.item_id = 30 then 60003760 else 1051882805548 end,
         case when v.item_id = 30 then 'station' else 'item' end,
         'Hangar'
  from public.character_asset_version v
  where v.location_id is null;

-- Corp items. 98001 at P: office 1000 holding container 1001 holding 1002. 98001
-- at S: office 2000. 98002 at P: office 3000.
insert into public.corp_asset_version (item_id, corporation_id, type_id, location_id) values
  (1000, 98001, 27, null),
  (1001, 98001, 17363, 1000),
  (1002, 98001, 34, 1001),
  (2000, 98001, 27, null),
  (3000, 98002, 27, null);
insert into public.corp_asset_location (asset_id, corporation_id, location_id, location_type, location_flag)
  select v.id, v.corporation_id,
         case when v.item_id = 2000 then 60003760 else 1051882805548 end,
         case when v.item_id = 2000 then 'station' else 'item' end,
         'OfficeFolder'
  from public.corp_asset_version v;

-- The shares, inserted as the migration role (the owner policies are tested in
-- asset_share.sql and corp_asset_share.sql): a1 shares P with bob's corp; a2
-- shares ship 40 — an ITEM share — with bob's corp; corp 98001 shares P
-- publicly.
insert into public.character_asset_share (registration_id, item_id, corporation_ids) values
  ('00000000-0000-0000-0000-0000000000a1', 1051882805548, '{98002}'),
  ('00000000-0000-0000-0000-0000000000a2', 40, '{98002}');
insert into public.corp_asset_share (corporation_id, created_by, item_id) values
  (98001, '00000000-0000-0000-0000-0000000000a1', 1051882805548);

-- ── the character place share ──────────────────────────────────────────────
do $$
begin
  perform set_config('test.uid', 'b0000000-0000-0000-0000-000000000000', true);
  assert public.asset_share_covers(10, '00000000-0000-0000-0000-0000000000a1'), 'a root at the shared place is covered';
  assert public.asset_share_covers(12, '00000000-0000-0000-0000-0000000000a1'), 'what is inside it is covered';
  assert public.asset_share_covers(20, '00000000-0000-0000-0000-0000000000a1'), 'every root of the grantor there is covered';
  assert not public.asset_share_covers(30, '00000000-0000-0000-0000-0000000000a1'), 'the grantor''s items elsewhere are not';
  -- The alt on the same account holds ship 40 at P: a1's place share is the
  -- ACCOUNT's, so it covers a2's root there and what is inside it too.
  assert public.asset_share_covers(40, '00000000-0000-0000-0000-0000000000a2'), 'a sibling character''s root at the place is covered';
  assert public.asset_share_covers(41, '00000000-0000-0000-0000-0000000000a2'), 'and what is inside it';
  assert not public.asset_share_covers(50, '00000000-0000-0000-0000-0000000000bb'), 'another owner''s item at the place is not covered';

  -- Depth: 115 is 15 below the root (the place is the 16th climb), 116 is 16.
  assert public.asset_share_covers(115, '00000000-0000-0000-0000-0000000000a1'), '15 levels under the root is covered';
  assert not public.asset_share_covers(116, '00000000-0000-0000-0000-0000000000a1'), 'the cap stops a place share at the same 16 climbs';

  -- Carol is not in the audience.
  perform set_config('test.uid', 'c0000000-0000-0000-0000-000000000000', true);
  assert not public.asset_share_covers(10, '00000000-0000-0000-0000-0000000000a1'), 'outside the audience, nothing';
end $$;

do $$
declare
  ids bigint[];
  place bigint;
  n int;
begin
  set local role authenticated;
  perform set_config('test.uid', 'b0000000-0000-0000-0000-000000000000', true);

  -- What the location page asks: the account's roots at the place, by place —
  -- a1's and its alt a2's, and nobody else's.
  ids := array(
    select item_id from public.character_asset
    where location_id = 1051882805548 and registration_id <> '00000000-0000-0000-0000-0000000000bb'
    order by item_id
  );
  assert ids = '{10,20,40}', format('the recipient lists exactly the account''s roots at the place, got %s', ids);

  select location_id into place from public.character_asset where item_id = 10;
  assert place = 1051882805548, format('a covered root reads the place the share names, got %s', place);
  select location_id into place from public.character_asset where item_id = 11;
  assert place = 10, format('a link inside the tree still reads, got %s', place);

  select location_id into place from public.character_asset where item_id = 40;
  assert place = 1051882805548, format('a sibling''s covered root reads the place too, got %s', place);

  -- Nothing else of a1's: the root at S is invisible altogether.
  select count(*) into n from public.character_asset where item_id = 30;
  assert n = 0, 'the grantor''s root elsewhere is not readable';

  -- Place rows a recipient reads: a2's only for its root at P.
  select count(*) into n from public.character_asset_location
    where registration_id = '00000000-0000-0000-0000-0000000000a2';
  assert n = 1, format('the sibling''s place row at the named place, got %s', n);

  -- The owner still reads everything.
  perform set_config('test.uid', 'a0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.character_asset where registration_id <> '00000000-0000-0000-0000-0000000000bb';
  assert n = 23, format('the owner reads every row of both characters, got %s', n);
  select location_id into place from public.character_asset where item_id = 30;
  assert place = 60003760, format('the owner reads every place, got %s', place);

  reset role;
end $$;

-- ── the corp place share ───────────────────────────────────────────────────
do $$
declare
  ids bigint[];
  place bigint;
begin
  perform set_config('test.uid', '', true);
  -- The subject's own id rides along from the item-share seed. It names no
  -- row here (the corporation does not own P as an asset), and where a corp
  -- does own its structure, sharing that id always covered it anyway.
  ids := array(select x from public.corp_shared_item_ids() x order by x);
  assert ids = '{1000,1001,1002,1051882805548}', format('a corp place share covers the corp''s roots there and their trees, got %s', ids);

  set local role anon;
  ids := array(select item_id from public.corp_asset where location_id = 1051882805548 order by item_id);
  assert ids = '{1000}', format('anon lists the corporation''s roots at the place and no other corp''s, got %s', ids);
  select location_id into place from public.corp_asset where item_id = 1000;
  assert place = 1051882805548, format('a covered corp root reads the place the share names, got %s', place);
  ids := array(select item_id from public.corp_asset where item_id in (2000, 3000));
  assert ids = '{}', format('neither the corp''s office elsewhere nor another corp''s at the place, got %s', ids);
  reset role;
end $$;

-- Stopping the share closes it on the next read.
delete from public.character_asset_share where item_id = 1051882805548;
do $$
declare n int; place bigint;
begin
  set local role authenticated;
  perform set_config('test.uid', 'b0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.character_asset where registration_id = '00000000-0000-0000-0000-0000000000a1';
  assert n = 0, format('a stopped place share opens nothing, got %s', n);

  -- a2's ITEM share on ship 40 remains, and keeps hiding its root's place.
  select count(*) into n from public.character_asset where item_id = 40;
  assert n = 1, 'the item share still opens the ship';
  select location_id into place from public.character_asset where item_id = 40;
  assert place is null, format('an item share does not reveal where its root is, got %s', place);
  reset role;
end $$;

rollback;
