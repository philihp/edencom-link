-- SQL-level coverage for the corp_bpo_share migration
-- (docs/bpo-showcase-corp.md): the member-manage policy (any account with a
-- character in the corporation, and NOBODY else), and the audience-read policy
-- through share_audience_matches().
--
-- The membership rule is the load-bearing one: it is what lets a corp-mate
-- publish the library, and what must stop an outsider from publishing —
-- or revoking — a corporation's showcase they have no character in.
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
create table if not exists auth.users (
  id uuid primary key
);
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

\i supabase/migrations/20260824211340_corp_bpo_share.sql

-- Fixtures. Corporation 98001 (alliance 99001) is the one with a showcase;
-- alice and bob both have characters in it, carol is in an alliance-mate corp
-- 98002, and dave is unaffiliated.
insert into auth.users values
  ('a0000000-0000-0000-0000-000000000000'),
  ('b0000000-0000-0000-0000-000000000000'),
  ('c0000000-0000-0000-0000-000000000000'),
  ('d0000000-0000-0000-0000-000000000000');
insert into public.corporation values (98001, 99001), (98002, 99001), (98003, null);
insert into public.registration values
  ('00000000-0000-0000-0000-0000000000aa', 'a0000000-0000-0000-0000-000000000000', 98001),
  ('00000000-0000-0000-0000-0000000000bb', 'b0000000-0000-0000-0000-000000000000', 98001),
  ('00000000-0000-0000-0000-0000000000cc', 'c0000000-0000-0000-0000-000000000000', 98002),
  ('00000000-0000-0000-0000-0000000000dd', 'd0000000-0000-0000-0000-000000000000', null);

do $$
declare
  n int;
begin
  -- A member publishes the corporation's showcase, aimed at its own alliance.
  set local role authenticated;
  perform set_config('test.uid', 'a0000000-0000-0000-0000-000000000000', true);
  insert into public.corp_bpo_share (corporation_id, alliance_ids)
    values (98001, '{99001}');

  -- The OTHER member of the same corp can edit it: the row belongs to the
  -- corporation, not to whoever created it.
  perform set_config('test.uid', 'b0000000-0000-0000-0000-000000000000', true);
  update public.corp_bpo_share set corporation_ids = '{98002}' where corporation_id = 98001;
  get diagnostics n = row_count;
  assert n = 1, 'a corp-mate can edit the corporation''s share row';

  -- An outsider cannot create a share for a corporation they are not in.
  perform set_config('test.uid', 'd0000000-0000-0000-0000-000000000000', true);
  begin
    insert into public.corp_bpo_share (corporation_id) values (98003);
    assert false, 'an outsider must not be able to publish a corporation''s library';
  exception when insufficient_privilege then null;
  end;

  -- Nor delete one. RLS makes the row invisible to the delete rather than
  -- raising: what matters is that it survives.
  delete from public.corp_bpo_share where corporation_id = 98001;
  get diagnostics n = row_count;
  assert n = 0, 'an outsider cannot revoke a corporation''s share';

  -- Audience: the row names alliance 99001 and corp 98002, so carol (in 98002,
  -- alliance 99001) reads it and dave does not.
  perform set_config('test.uid', 'c0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.corp_bpo_share;
  assert n = 1, format('an alliance-mate reads the share aimed at them, got %s', n);

  perform set_config('test.uid', 'd0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.corp_bpo_share;
  assert n = 0, format('an unaffiliated caller reads nothing, got %s', n);

  -- A link-only row (secret set, audience empty) matches NOBODY under RLS —
  -- the token is invisible to the database, so the app layer resolves it.
  perform set_config('test.uid', 'a0000000-0000-0000-0000-000000000000', true);
  update public.corp_bpo_share
    set corporation_ids = '{}', alliance_ids = '{}', secret = 'deadbeef'
    where corporation_id = 98001;

  perform set_config('test.uid', 'c0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.corp_bpo_share;
  assert n = 0, format('a link-only share matches nobody under RLS, got %s', n);

  reset role;
  set local role anon;
  perform set_config('test.uid', '', true);
  select count(*) into n from public.corp_bpo_share;
  assert n = 0, format('a link-only share is invisible to anon, got %s', n);

  -- Fully public: the row that names no one, with no secret.
  reset role;
  set local role authenticated;
  perform set_config('test.uid', 'a0000000-0000-0000-0000-000000000000', true);
  update public.corp_bpo_share set secret = null where corporation_id = 98001;

  reset role;
  set local role anon;
  perform set_config('test.uid', '', true);
  select count(*) into n from public.corp_bpo_share;
  assert n = 1, format('a fully public share is readable signed-out, got %s', n);

  reset role;
end $$;

rollback;
