-- SQL-level coverage for the corp share author gate
-- (supabase/migrations/20261014203448_corp_share_author_gate.sql): a
-- corp_asset_share works only while the character in created_by still sits in
-- the grantor corporation, read from the world-readable character_directory.
-- When they leave, the audience reads neither the share row, nor the items it
-- covered, nor the place a place share names. A member still in the
-- corporation revives it by saving it, which stamps them as created_by; nobody
-- can stamp a character of theirs outside the corporation.
--
-- The harness is place_share.sql's (every migration the corp share stands on),
-- plus a character_directory stand-in.
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

-- The directory the gate reads, copied from schema.sql (world-readable).
create table public.character_directory (
  character_id bigint primary key,
  name text,
  corporation_id bigint,
  alliance_id bigint,
  registration_id uuid unique references public.registration (id) on delete set null,
  updated_at timestamptz not null default now()
);
alter table public.character_directory enable row level security;
create policy "Everyone reads the character directory"
  on public.character_directory
  for select
  to anon, authenticated
  using (true);
grant select on public.character_directory to anon, authenticated;

-- The migration under test.
\i supabase/migrations/20261014203448_corp_share_author_gate.sql

-- Fixtures. Alice's ACCOUNT holds a1 and her alt a2 in corp 98001; bob is in
-- 98002; carol, unaffiliated. P is a player structure, S a station.
insert into public.corporation values (98001, 99001), (98002, 99002);
insert into public.registration values
  ('00000000-0000-0000-0000-0000000000a1', 'a0000000-0000-0000-0000-000000000000', 98001),
  ('00000000-0000-0000-0000-0000000000a2', 'a0000000-0000-0000-0000-000000000000', 98001),
  ('00000000-0000-0000-0000-0000000000bb', 'b0000000-0000-0000-0000-000000000000', 98002),
  ('00000000-0000-0000-0000-0000000000cc', 'c0000000-0000-0000-0000-000000000000', null);
insert into public.character_directory (character_id, name, corporation_id, registration_id) values
  (1, 'a1', 98001, '00000000-0000-0000-0000-0000000000a1'),
  (2, 'a2', 98001, '00000000-0000-0000-0000-0000000000a2'),
  (3, 'bb', 98002, '00000000-0000-0000-0000-0000000000bb'),
  (4, 'cc', null, '00000000-0000-0000-0000-0000000000cc');

-- Corp 98001: office 1000 at P holding container 1001 holding 1002; office 2000
-- at S.
insert into public.corp_asset_version (item_id, corporation_id, type_id, location_id) values
  (1000, 98001, 27, null),
  (1001, 98001, 17363, 1000),
  (1002, 98001, 34, 1001),
  (2000, 98001, 27, null);
insert into public.corp_asset_location (asset_id, corporation_id, location_id, location_type, location_flag)
  select v.id, v.corporation_id,
         case when v.item_id = 2000 then 60003760 else 1051882805548 end,
         case when v.item_id = 2000 then 'station' else 'item' end,
         'OfficeFolder'
  from public.corp_asset_version v
  where v.location_id is null;

-- Made by a1 on corp 98001's behalf: container 1001 to bob's corp, and the place
-- S publicly.
insert into public.corp_asset_share (corporation_id, created_by, item_id, corporation_ids) values
  (98001, '00000000-0000-0000-0000-0000000000a1', 1001, '{98002}'),
  (98001, '00000000-0000-0000-0000-0000000000a1', 60003760, '{}');

-- ── while the author is in the corporation, the shares work ────────────────
do $$
declare n int;
begin
  assert public.corp_share_author_active(98001, '00000000-0000-0000-0000-0000000000a1'), 'a1 is in 98001';
  assert not public.corp_share_author_active(98002, '00000000-0000-0000-0000-0000000000a1'), 'a1 is not in 98002';
  assert not public.corp_share_author_active(98001, null), 'a share with no author is never active';

  set local role authenticated;
  perform set_config('test.uid', 'b0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.corp_asset_share;
  assert n = 2, format('bob reads both shares aimed at him, got %s', n);
  assert 1002 = any(array(select public.corp_shared_item_ids())), 'the shared container''s contents are covered';
  select count(*) into n from public.corp_asset where item_id = 2000 and location_id = 60003760;
  assert n = 1, format('the place share names its place to the audience, got %s', n);
  reset role;
end $$;

-- ── the author leaves the corporation: both shares stop ────────────────────
update public.character_directory set corporation_id = 98002
  where registration_id = '00000000-0000-0000-0000-0000000000a1';

do $$
declare n int;
begin
  set local role authenticated;
  perform set_config('test.uid', 'b0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.corp_asset_share where corporation_id = 98001;
  assert n = 0, format('the audience reads no share whose author left, got %s', n);
  assert not (1002 = any(array(select public.corp_shared_item_ids()))), 'nothing under the item share is covered';
  assert not (2000 = any(array(select public.corp_shared_item_ids()))), 'nothing at the shared place is covered';
  select count(*) into n from public.corp_asset where corporation_id = 98001;
  assert n = 0, format('bob reads none of 98001''s hangar, got %s', n);
  reset role;

  set local role anon;
  perform set_config('test.uid', '', true);
  select count(*) into n from public.corp_asset_share;
  assert n = 0, format('a public share whose author left is gone signed-out too, got %s', n);
  select count(*) into n from public.corp_asset;
  assert n = 0, format('anon reads nothing from it, got %s', n);
  reset role;

  -- The rows are still there: the corporation's members still see and manage
  -- them. a2 is alice's alt, still in 98001.
  set local role authenticated;
  perform set_config('test.uid', 'a0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.corp_asset_share where corporation_id = 98001;
  assert n = 2, format('a member still reads the inactive shares, got %s', n);
  reset role;
end $$;

-- ── a write must be made on behalf of a character in the corporation ───────
do $$
declare n int;
begin
  set local role authenticated;
  perform set_config('test.uid', 'a0000000-0000-0000-0000-000000000000', true);
  begin
    -- Bob's character is in neither alice's account nor 98001.
    update public.corp_asset_share set created_by = '00000000-0000-0000-0000-0000000000bb' where item_id = 1001;
    assert false, 'created_by must not name another account''s character';
  exception when insufficient_privilege then null;
  end;

  -- a2 saves the item share: the share is now made on a2's behalf, and works.
  update public.corp_asset_share set created_by = '00000000-0000-0000-0000-0000000000a2' where item_id = 1001;
  get diagnostics n = row_count;
  assert n = 1, 'a member still in the corporation can take over the share';
  reset role;

  set local role authenticated;
  perform set_config('test.uid', 'b0000000-0000-0000-0000-000000000000', true);
  assert 1002 = any(array(select public.corp_shared_item_ids())), 'the revived share covers again';
  -- The place share, still a1's, stays off.
  assert not (2000 = any(array(select public.corp_shared_item_ids()))), 'the other share stays inactive';
  reset role;
end $$;

-- A character outside the grantor corporation can't be stamped, even one of the
-- caller's own: once a1's registration says 98002, alice can't write as a1.
update public.registration set corporation_id = 98002 where id = '00000000-0000-0000-0000-0000000000a1';
do $$
begin
  set local role authenticated;
  perform set_config('test.uid', 'a0000000-0000-0000-0000-000000000000', true);
  begin
    update public.corp_asset_share set created_by = '00000000-0000-0000-0000-0000000000a1' where item_id = 1001;
    assert false, 'created_by must name a character in the grantor corporation';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.corp_asset_share (corporation_id, created_by, item_id)
      values (98001, '00000000-0000-0000-0000-0000000000a1', 2000);
    assert false, 'an insert must name a character in the grantor corporation';
  exception when insufficient_privilege then null;
  end;
  reset role;
end $$;

-- ── unlinking the author's character nulls created_by: inactive, not deleted ─
delete from public.character_directory where registration_id = '00000000-0000-0000-0000-0000000000a2';
delete from public.registration where id = '00000000-0000-0000-0000-0000000000a2';
do $$
declare n int;
begin
  select count(*) into n from public.corp_asset_share where item_id = 1001 and created_by is null;
  assert n = 1, 'the row survives its author''s registration, created_by nulled';
  perform set_config('test.uid', 'b0000000-0000-0000-0000-000000000000', true);
  assert not (1002 = any(array(select public.corp_shared_item_ids()))), 'a share with no author covers nothing';
end $$;

rollback;
