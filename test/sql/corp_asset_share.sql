-- SQL-level coverage for the corp_asset_share migration
-- (docs/sharing-layer/14-corp-asset-share.md, PR 2): the member-manage
-- policies (any account with a character in the grantor corporation, and
-- NOBODY else), the audit column's insert guard, and the audience-read policy
-- through share_audience_matches().
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

\i supabase/migrations/20261013062951_corp_asset_share.sql

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
