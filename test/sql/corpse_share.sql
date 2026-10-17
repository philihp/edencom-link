-- SQL-level coverage for the corpse_share migration: the owner-manage policy
-- and the audience-read policy through share_audience_matches().
--
-- The page that reads this table lists one account's corpses pooled across
-- every character on it and titles itself with the account's main, so the row
-- is the whole of its authorization: no row must mean nobody but the owner,
-- and an outsider must not be able to mint or revoke one.
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

-- Stand-ins for the FK target and the audience helpers' inputs.
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

\i supabase/migrations/20261016235844_corpse_share.sql

-- Fixtures. Alice keeps the corpses; bob is a corp-mate (98001, alliance
-- 99001), carol is in an alliance-mate corp, dave is unaffiliated.
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
  ('00000000-0000-0000-0000-0000000000dd', 'd0000000-0000-0000-0000-000000000000', 98003);

do $$
declare
  n int;
begin
  -- Nobody sees anything while the owner has not shared: no row at all.
  set local role authenticated;
  perform set_config('test.uid', 'b0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.corpse_share;
  assert n = 0, format('an unshared collection has no row to find, got %s', n);

  -- Alice shares with her own corporation.
  perform set_config('test.uid', 'a0000000-0000-0000-0000-000000000000', true);
  insert into public.corpse_share (user_id, corporation_ids)
    values ('a0000000-0000-0000-0000-000000000000', '{98001}');

  -- An outsider cannot mint a share on someone else's behalf...
  perform set_config('test.uid', 'd0000000-0000-0000-0000-000000000000', true);
  begin
    insert into public.corpse_share (user_id) values ('a0000000-0000-0000-0000-000000000000');
    assert false, 'an outsider must not be able to share another account''s corpses';
  exception when unique_violation then null;
       when insufficient_privilege then null;
  end;

  -- ...nor revoke one. RLS makes the row invisible to the delete rather than
  -- raising: what matters is that it survives.
  delete from public.corpse_share where user_id = 'a0000000-0000-0000-0000-000000000000';
  get diagnostics n = row_count;
  assert n = 0, 'an outsider cannot revoke another account''s share';

  -- Audience: the row names corp 98001, so the corp-mate reads it and the
  -- unaffiliated caller does not.
  perform set_config('test.uid', 'b0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.corpse_share;
  assert n = 1, format('a corp-mate reads the share aimed at them, got %s', n);

  perform set_config('test.uid', 'd0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.corpse_share;
  assert n = 0, format('an outsider reads nothing, got %s', n);

  -- An alliance share reaches the alliance-mate in the other corporation.
  perform set_config('test.uid', 'a0000000-0000-0000-0000-000000000000', true);
  update public.corpse_share
    set corporation_ids = '{}', alliance_ids = '{99001}'
    where user_id = 'a0000000-0000-0000-0000-000000000000';

  perform set_config('test.uid', 'c0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.corpse_share;
  assert n = 1, format('an alliance-mate reads an alliance share, got %s', n);

  -- A link-only row (secret set, audience empty) matches NOBODY under RLS —
  -- the token is invisible to the database, so the app layer resolves it.
  perform set_config('test.uid', 'a0000000-0000-0000-0000-000000000000', true);
  update public.corpse_share
    set alliance_ids = '{}', secret = 'deadbeef'
    where user_id = 'a0000000-0000-0000-0000-000000000000';

  perform set_config('test.uid', 'c0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.corpse_share;
  assert n = 0, format('a link-only share matches nobody under RLS, got %s', n);

  reset role;
  set local role anon;
  perform set_config('test.uid', '', true);
  select count(*) into n from public.corpse_share;
  assert n = 0, format('a link-only share is invisible to anon, got %s', n);

  -- Fully public: the row that names no one, with no secret.
  reset role;
  set local role authenticated;
  perform set_config('test.uid', 'a0000000-0000-0000-0000-000000000000', true);
  update public.corpse_share set secret = null where user_id = 'a0000000-0000-0000-0000-000000000000';

  reset role;
  set local role anon;
  perform set_config('test.uid', '', true);
  select count(*) into n from public.corpse_share;
  assert n = 1, format('a fully public share is readable signed-out, got %s', n);

  -- The owner can always revoke their own.
  reset role;
  set local role authenticated;
  perform set_config('test.uid', 'a0000000-0000-0000-0000-000000000000', true);
  delete from public.corpse_share where user_id = 'a0000000-0000-0000-0000-000000000000';
  get diagnostics n = row_count;
  assert n = 1, 'the owner revokes their own share';

  reset role;
end $$;

rollback;
