-- SQL-level coverage for the corp asset share
-- (docs/sharing-layer/14-corp-asset-share.md): PR 2's member-manage policies
-- (any account with a character in the grantor corporation, and NOBODY else),
-- the audit column's insert guard, the audience-read policy through
-- share_audience_matches(), and PR 3's widening policy on corp_asset_version —
-- what a share opens, what it does not, and that a recipient still gets no
-- place for the shared root.
--
-- The load-bearing rules here are the two the corp grantor introduces: a
-- corp-mate can edit or stop a share they did not create (the row belongs to
-- the corporation, not its author), and `created_by` can only ever name a
-- registration of the account inserting the row.
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

-- Stand-ins for the FK target and the membership helpers' inputs.
create table public.registration (
  id uuid primary key,
  user_id uuid,
  corporation_id bigint
);
create table public.corporation (
  corporation_id bigint primary key,
  alliance_id bigint
);
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

-- Stand-ins for the corp asset objects PR 3's policy and walk read, copied
-- from schema.sql: the split version table, the members-only place table, and
-- the two security-invoker views that put them back together. The views are
-- what the "a recipient reads no place" assertion needs to be meaningful.
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
create index corp_asset_version_corporation_id_idx on public.corp_asset_version (corporation_id);
create unique index corp_asset_version_current_item_idx on public.corp_asset_version (item_id) where is_current;
create index corp_asset_version_item_id_idx on public.corp_asset_version (item_id, valid_until desc);

alter table public.corp_asset_version enable row level security;
create policy "Users read assets for own corps"
  on public.corp_asset_version
  for select
  to authenticated
  using (
    corporation_id in (
      select corporation_id from public.registration
      where user_id = (select auth.uid()) and corporation_id is not null
    )
  );
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
  using (
    corporation_id in (
      select corporation_id from public.registration
      where user_id = (select auth.uid()) and corporation_id is not null
    )
  );
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

grant select on public.corp_asset_over_time to authenticated;
grant select on public.corp_asset           to authenticated;

-- The migrations under test: PR 2 (the share table) and PR 3 (the recursive
-- widening policy + corp_asset_share_covers).
\i supabase/migrations/20261013062951_corp_asset_share.sql
\i supabase/migrations/20261013064401_corp_asset_share_recursive_rls.sql

-- Fixtures. Corporation 98001 (alliance 99001) is the one whose hangar gets
-- shared; alice and bob are separate ACCOUNTS both holding a character in it
-- (that is what makes bob a corp-mate rather than an alt). Carol is in 98002,
-- alliance 99002; dave is unaffiliated.
insert into public.corporation values (98001, 99001), (98002, 99002);
insert into public.registration values
  ('00000000-0000-0000-0000-0000000000aa', 'a0000000-0000-0000-0000-000000000000', 98001),
  ('00000000-0000-0000-0000-0000000000bb', 'b0000000-0000-0000-0000-000000000000', 98001),
  ('00000000-0000-0000-0000-0000000000cc', 'c0000000-0000-0000-0000-000000000000', 98002),
  ('00000000-0000-0000-0000-0000000000dd', 'd0000000-0000-0000-0000-000000000000', null);

do $$
declare
  n int;
  author uuid;
begin
  set local role authenticated;

  -- ── the grant: a member shares their corporation's container ─────────────
  perform set_config('test.uid', 'a0000000-0000-0000-0000-000000000000', true);
  insert into public.corp_asset_share (corporation_id, created_by, item_id, corporation_ids)
    values (98001, '00000000-0000-0000-0000-0000000000aa', 1052154845801, '{98002}');

  select count(*) into n from public.corp_asset_share;
  assert n = 1, format('the grantor reads their corporation''s share, got %s', n);

  -- ── the audit column names one of the caller's own characters ────────────
  begin
    insert into public.corp_asset_share (corporation_id, created_by, item_id)
      values (98001, '00000000-0000-0000-0000-0000000000bb', 2000);
    assert false, 'created_by must not name another account''s registration';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into public.corp_asset_share (corporation_id, item_id) values (98001, 2001);
    assert false, 'created_by must be supplied at creation';
  exception when insufficient_privilege then null;
  end;

  -- ── the grantor corporation must be one of the caller's ─────────────────
  begin
    insert into public.corp_asset_share (corporation_id, created_by, item_id)
      values (98002, '00000000-0000-0000-0000-0000000000aa', 2002);
    assert false, 'a member must not share another corporation''s hangar';
  exception when insufficient_privilege then null;
  end;

  -- ── the row is the corporation's, not its author's ──────────────────────
  -- Bob, a different ACCOUNT in the same corp, reads it, edits the audience,
  -- and could stop it — the whole point of the corp grantor.
  perform set_config('test.uid', 'b0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.corp_asset_share;
  assert n = 1, format('a corp-mate reads the corporation''s share, got %s', n);

  update public.corp_asset_share set alliance_ids = '{99002}' where item_id = 1052154845801;
  get diagnostics n = row_count;
  assert n = 1, 'a corp-mate can edit the corporation''s share';

  -- …and editing it never rewrites the audit column.
  select created_by into author from public.corp_asset_share where item_id = 1052154845801;
  assert author = '00000000-0000-0000-0000-0000000000aa', 'created_by still names the author';

  -- ── the row cannot be re-pointed at another corporation ─────────────────
  begin
    update public.corp_asset_share set corporation_id = 98002 where item_id = 1052154845801;
    assert false, 'with check must refuse re-pointing the row at another corp';
  exception when insufficient_privilege then null;
  end;

  -- ── an outsider neither reads the row as an owner, nor removes it ───────
  -- Carol is in 98002, which the row's audience names, so she reads it through
  -- the AUDIENCE policy — but not as an owner: the delete sees nothing.
  perform set_config('test.uid', 'c0000000-0000-0000-0000-000000000000', true);
  delete from public.corp_asset_share where item_id = 1052154845801;
  get diagnostics n = row_count;
  assert n = 0, 'an outsider cannot revoke a corporation''s share';

  begin
    insert into public.corp_asset_share (corporation_id, created_by, item_id)
      values (98001, '00000000-0000-0000-0000-0000000000cc', 2003);
    assert false, 'an outsider must not be able to share a corporation''s hangar';
  exception when insufficient_privilege then null;
  end;

  -- ── audience matching (the shared helper's, so one assertion each) ──────
  select count(*) into n from public.corp_asset_share;
  assert n = 1, format('a member of a named corporation reads the share, got %s', n);

  perform set_config('test.uid', 'd0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.corp_asset_share;
  assert n = 0, format('an unaffiliated caller reads nothing, got %s', n);

  -- Alliance grant alone: the row names alliance 99002, carol's.
  perform set_config('test.uid', 'a0000000-0000-0000-0000-000000000000', true);
  update public.corp_asset_share set corporation_ids = '{}' where item_id = 1052154845801;
  perform set_config('test.uid', 'c0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.corp_asset_share;
  assert n = 1, format('an alliance-mate reads the alliance share, got %s', n);

  -- Link-only (secret set, audience empty) matches NOBODY under RLS: the URL
  -- token is invisible to the database, so the app layer resolves it.
  perform set_config('test.uid', 'a0000000-0000-0000-0000-000000000000', true);
  update public.corp_asset_share
    set corporation_ids = '{}', alliance_ids = '{}', secret = 'deadbeef'
    where item_id = 1052154845801;

  perform set_config('test.uid', 'c0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.corp_asset_share;
  assert n = 0, format('a link-only share matches nobody under RLS, got %s', n);

  reset role;
  set local role anon;
  perform set_config('test.uid', '', true);
  select count(*) into n from public.corp_asset_share;
  assert n = 0, format('a link-only share is invisible to anon, got %s', n);

  -- Fully public: the row that names no one, with no secret.
  reset role;
  set local role authenticated;
  perform set_config('test.uid', 'a0000000-0000-0000-0000-000000000000', true);
  update public.corp_asset_share set secret = null where item_id = 1052154845801;

  reset role;
  set local role anon;
  perform set_config('test.uid', '', true);
  select count(*) into n from public.corp_asset_share;
  assert n = 1, format('a fully public share is readable signed-out, got %s', n);

  reset role;
end $$;

-- ── PR 3: the widening policy and corp_shared_item_ids() ───────────────────
-- Corp 98001's hangar, shaped like production: the Office (type 27) is the root
-- naming the station, and everything in a hangar links to it. Office 1000 holds
-- container 100 (holding 101 holding 102), sibling container 200 (holding 201),
-- and a 17-deep chain under 300 to probe the depth cap. Ship 400 is a second
-- ROOT — its place lives in corp_asset_location, which is what makes the
-- "a recipient reads no place" assertion say something.
--
-- Item 500 belongs to corp 98002 and claims corp 98001's shared container as
-- its parent. PR 1's same-owner rule means production files such a row as a
-- root instead, so this is defence in depth: it must not ride 98001's share.
insert into public.corp_asset_version (item_id, corporation_id, type_id, location_id) values
  (1000, 98001, 27, null),
  (100, 98001, 17363, 1000),
  (101, 98001, 17363, 100),
  (102, 98001, 34, 101),
  (200, 98001, 17363, 1000),
  (201, 98001, 34, 200),
  (400, 98001, 19720, null),
  (401, 98001, 34, 400),
  (500, 98002, 34, 100);
insert into public.corp_asset_version (item_id, corporation_id, type_id, location_id)
  select 300 + n, 98001, 17363, case when n = 0 then 1000 else 300 + n - 1 end
  from generate_series(0, 17) n;
insert into public.corp_asset_location (asset_id, corporation_id, location_id, location_type, location_flag)
  select v.id, 98001, 60003760, 'station', 'OfficeFolder'
  from public.corp_asset_version v where v.item_id in (1000, 400);

-- The shares, inserted as the migration role (the owner policies are PR 2's
-- business, asserted above): container 100 to corp 98002, and container 200,
-- the chain root 300 and ship 400 publicly.
insert into public.corp_asset_share (corporation_id, created_by, item_id, corporation_ids) values
  (98001, '00000000-0000-0000-0000-0000000000aa', 100, '{98002}');
insert into public.corp_asset_share (corporation_id, created_by, item_id) values
  (98001, '00000000-0000-0000-0000-0000000000aa', 200),
  (98001, '00000000-0000-0000-0000-0000000000aa', 300),
  (98001, '00000000-0000-0000-0000-0000000000aa', 400);

do $$
declare covered bigint[];
begin
  -- Carol (corp 98002) is covered by the shared container and everything
  -- nested in it…
  perform set_config('test.uid', 'c0000000-0000-0000-0000-000000000000', true);
  covered := array(select public.corp_shared_item_ids());
  assert 100 = any(covered), 'shared container is covered';
  assert 101 = any(covered), 'direct child is covered';
  assert 102 = any(covered), 'grandchild is covered';
  -- …and not by what the share does not name: the Office holding it is above
  -- the share, not inside it, so sharing a container never opens its hangar.
  assert not (1000 = any(covered)), 'the office above the shared container is not covered';
  -- The descent never leaves the grantor corporation.
  assert not (500 = any(covered)), 'another corporation''s item cannot ride the share by naming it as parent';

  -- Depth cap 16 (matching asset_ancestors): 316 is 16 levels under the shared
  -- root 300 and covered; 317 is 17 and not.
  assert 316 = any(covered), 'item 16 levels under the shared root is covered';
  assert not (317 = any(covered)), 'depth cap stops the 17th level';

  -- Dave (unaffiliated) gets only the public shares' subtrees.
  perform set_config('test.uid', 'd0000000-0000-0000-0000-000000000000', true);
  covered := array(select public.corp_shared_item_ids());
  assert not (102 = any(covered)), 'corp-shared item hidden from an unaffiliated account';
  assert 201 = any(covered), 'public share covers nested items';

  -- Anon rides the public shares only.
  perform set_config('test.uid', '', true);
  covered := array(select public.corp_shared_item_ids());
  assert 201 = any(covered), 'anon sees inside the public container';
  assert not (102 = any(covered)), 'anon does not see the corp-shared container';
end $$;

-- Policy-level smoke under RLS, which is the definer's whole purpose: the
-- widening policy fires without "infinite recursion detected in policy", and
-- the select returns exactly the covered rows.
--
-- The fixture is 27 rows, 26 of them corp 98001's. Carol's read: 100/101/102
-- (corp share), 200/201 and 300..316 (public, 317 past the cap), 400/401 = 24
-- covered, plus her own corporation's row 500 as a member = 25. Anon has the
-- 24 minus the three corp-shared rows = 21. A member of 98001 reads its 26.
do $$
declare n int;
begin
  set local role authenticated;
  perform set_config('test.uid', 'c0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.corp_asset;
  assert n = 25, format('a corp-share recipient sees the covered rows plus their own corp, got %s', n);

  reset role;
  set local role anon;
  perform set_config('test.uid', '', true);
  select count(*) into n from public.corp_asset;
  assert n = 21, format('anon sees only the public shares'' rows, got %s', n);

  reset role;
  set local role authenticated;
  perform set_config('test.uid', 'a0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.corp_asset;
  assert n = 26, format('a member still reads the whole hangar, got %s', n);
  reset role;
end $$;

-- The location assertion (the reason PR 1 came first): a recipient reading the
-- shared ROOT through the view gets location_id null — corp_asset_location is
-- members-only and the definer never reads it — while a member reads the place.
do $$
declare place bigint;
begin
  set local role authenticated;
  perform set_config('test.uid', 'c0000000-0000-0000-0000-000000000000', true);
  select location_id into place from public.corp_asset where item_id = 400;
  assert place is null, format('a recipient reads no place for the shared root, got %s', place);

  -- Nor the parent of the shared container, an Office it cannot see.
  select location_id into place from public.corp_asset where item_id = 100;
  assert place is null, format('a recipient reads no parent it cannot see, got %s', place);

  -- …but a parent link inside the shared subtree still reads through.
  select location_id into place from public.corp_asset where item_id = 101;
  assert place = 100, format('a parent link inside the share still reads, got %s', place);

  perform set_config('test.uid', 'a0000000-0000-0000-0000-000000000000', true);
  select location_id into place from public.corp_asset where item_id = 400;
  assert place = 60003760, format('a member still reads the place, got %s', place);
  reset role;
end $$;

-- Revoking the corp share closes access on the next read.
delete from public.corp_asset_share where item_id = 100;
do $$
declare n int;
begin
  perform set_config('test.uid', 'c0000000-0000-0000-0000-000000000000', true);
  assert not (102 = any(array(select public.corp_shared_item_ids()))), 'revoked share no longer covers';

  set local role authenticated;
  select count(*) into n from public.corp_asset;
  assert n = 22, format('the revoked subtree is gone from the recipient''s read, got %s', n);
  reset role;
end $$;

-- The author's account closing must not end the corporation's share: the FK is
-- `on delete set null`, so the row survives with no audit trail.
delete from public.registration where id = '00000000-0000-0000-0000-0000000000aa';
do $$
declare n int;
begin
  select count(*) into n from public.corp_asset_share
    where item_id = 1052154845801 and created_by is null;
  assert n = 1, 'the share outlives its author''s registration, created_by nulled';
end $$;

rollback;
