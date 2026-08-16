-- SQL-level coverage for the link migration
-- (docs/sharing-layer/07-link.md): owner-only management, the audience-read
-- policy through share_audience_matches(), and — the link-specific semantic —
-- the `enabled` gate: because the link row IS the share row, an UNSHARED link
-- must be invisible to everyone but its owner even though its default empty
-- audience would otherwise read as "public".
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

-- Stand-in for auth.users (the link FK target) and the membership helpers'
-- inputs.
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

-- The shared matcher the audience policy calls (created by the
-- fitting_share_unified migration in prod).
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

\i supabase/migrations/20260806130000_link.sql
-- The share gate arrives as `shared` and is renamed by the follow-up; the
-- assertions below run against the post-rename `enabled`, which also proves
-- the audience-read policy followed the rename (its qual is a node tree over
-- the attribute, not the text).
\i supabase/migrations/20260806140000_link_enabled.sql

-- Fixtures: alice (corp 98001 / alliance 99001) owns four links in different
-- share states; bob is a corp-mate, carol is unaffiliated.
insert into auth.users values
  ('a0000000-0000-0000-0000-000000000000'),
  ('b0000000-0000-0000-0000-000000000000'),
  ('c0000000-0000-0000-0000-000000000000');
insert into public.corporation values (98001, 99001);
insert into public.registration values
  ('00000000-0000-0000-0000-0000000000aa', 'a0000000-0000-0000-0000-000000000000', 98001),
  ('00000000-0000-0000-0000-0000000000bb', 'b0000000-0000-0000-0000-000000000000', 98001),
  ('00000000-0000-0000-0000-0000000000cc', 'c0000000-0000-0000-0000-000000000000', null);
insert into public.link (id, user_id, name, query, enabled, corporation_ids, alliance_ids, secret) values
  -- Freshly created: never shared. The empty audience must NOT read as public.
  ('11111111-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000000', 'unshared', '{ x }', false, '{}', '{}', null),
  -- Shared with the corp.
  ('11111111-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000000', 'corp', '{ x }', true, '{98001}', '{}', null),
  -- Fully public: shared with an audience that names no one.
  ('11111111-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000000', 'public', '{ x }', true, '{}', '{}', null),
  -- Link-only: a secret and nobody else. Invisible to RLS by design.
  ('11111111-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000000', 'link', '{ x }', true, '{}', '{}', 'deadbeef');

do $$
declare
  n int;
begin
  -- Owner sees all four.
  set local role authenticated;
  perform set_config('test.uid', 'a0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.link;
  assert n = 4, format('owner sees all their links, got %s', n);

  -- Corp-mate bob: the corp-shared and public links — never the unshared or
  -- link-only ones.
  perform set_config('test.uid', 'b0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.link;
  assert n = 2, format('corp-mate sees corp + public, got %s', n);
  select count(*) into n from public.link where name in ('corp', 'public');
  assert n = 2, 'corp-mate sees exactly the corp and public links';

  -- Unaffiliated carol: only the public link.
  perform set_config('test.uid', 'c0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.link;
  assert n = 1, format('unaffiliated caller sees only public, got %s', n);

  -- Signed-out anon: only the public link.
  reset role;
  set local role anon;
  perform set_config('test.uid', '', true);
  select count(*) into n from public.link;
  assert n = 1, format('anon sees only public, got %s', n);

  -- The unshared link is invisible to everyone but the owner: the enabled
  -- gate, not the audience, is what held it back.
  select count(*) into n from public.link where name = 'unshared';
  assert n = 0, 'an unshared link never leaks through the empty-audience-is-public reading';

  reset role;

  -- Non-owner writes bounce off RLS: bob's update matches no row.
  set local role authenticated;
  perform set_config('test.uid', 'b0000000-0000-0000-0000-000000000000', true);
  update public.link set enabled = true where name = 'unshared';
  get diagnostics n = row_count;
  assert n = 0, 'a non-owner cannot flip another user''s link to enabled';
  reset role;
end $$;

rollback;
