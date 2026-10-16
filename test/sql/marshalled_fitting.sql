-- SQL-level coverage for marshalled_fitting (docs/fitting-marshal.md PR 1):
-- the rules Postgres enforces rather than the app does.
--
--   * an owner reads their own rows and nobody else's;
--   * `authenticated` can neither insert, update nor delete — every write goes
--     through the service role after the request proved who it is;
--   * (user_id, content_hash) is the identity: the same fit twice is one row;
--   * the hash is checked for shape, so a bare fitting id or a uuid can never
--     be stored as a handle;
--   * unlinking the source character keeps the fit (on delete set null).
--
-- Run against a THROWAWAY database from the repo root (it creates stand-in
-- tables named after the real ones): DATABASE_URL='postgresql://…/throwaway'
-- pnpm run test:sql. Everything runs in one transaction and rolls back.
begin;

do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin; exception when duplicate_object then null; end $$;

create schema if not exists auth;
create or replace function auth.uid() returns uuid
language sql stable
as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;

-- Stand-ins. The real table also references auth.users; the user id is just
-- a uuid here, since no rule under test depends on that row.
create table public.registration (
  id uuid primary key,
  user_id uuid
);
create table public.fitting_write_log (
  id bigint generated always as identity primary key
);

-- The table under test, verbatim from the migration minus the auth.users FK.
create table public.marshalled_fitting (
  user_id uuid not null,
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  name text not null,
  description text not null default '',
  ship_type_id bigint not null,
  items jsonb not null default '[]'::jsonb,
  source_registration_id uuid references public.registration(id) on delete set null,
  source_fitting_id bigint,
  write_log_id bigint references public.fitting_write_log(id) on delete set null,
  source text not null default 'api',
  marshalled_at timestamptz not null default now(),
  primary key (user_id, content_hash)
);
create index marshalled_fitting_user_recent_idx
  on public.marshalled_fitting (user_id, marshalled_at desc);

alter table public.marshalled_fitting enable row level security;
create policy "Users read own marshalled fittings"
  on public.marshalled_fitting
  for select
  to authenticated
  using (user_id = (select auth.uid()));

grant usage on schema public to authenticated;
grant select on public.marshalled_fitting to authenticated;
grant all    on public.marshalled_fitting to service_role;

\set alice 'a0000000-0000-0000-0000-000000000000'
\set bob   'b0000000-0000-0000-0000-000000000000'
\set reg   '00000000-0000-0000-0000-0000000000aa'
\set hash1 '1111111111111111111111111111111111111111111111111111111111111111'
\set hash2 '2222222222222222222222222222222222222222222222222222222222222222'

insert into public.registration values (:'reg', :'alice');

-- Written as the service role would: directly, no policy involved.
insert into public.marshalled_fitting
  (user_id, content_hash, name, ship_type_id, items, source_registration_id, source_fitting_id, source)
values
  (:'alice', :'hash1', 'Doctrine Cane', 24702, '[{"type_id":2048,"flag":"LoSlot0","quantity":1}]', :'reg', 42, 'web'),
  (:'bob',   :'hash2', 'Cheap Tackle',  587,   '[]', null, null, 'fuse');

-- ── The identity is (user_id, content_hash) ──────────────────────────────
-- The same fit marshalled again from another alt is an upsert, never a second
-- row — but a plain insert collides, which is what the upsert leans on.
do $$
begin
  insert into public.marshalled_fitting (user_id, content_hash, name, ship_type_id)
  values ('a0000000-0000-0000-0000-000000000000',
          '1111111111111111111111111111111111111111111111111111111111111111', 'Doctrine Cane', 24702);
  raise exception 'the same fit was stored twice for one account';
exception when unique_violation then
  null;
end $$;

-- The same content on ANOTHER account is a different row: the archive is per
-- account, and two players may well hold the same doctrine fit.
insert into public.marshalled_fitting (user_id, content_hash, name, ship_type_id)
values (:'bob', :'hash1', 'Doctrine Cane', 24702);

-- ── The handle has a shape ────────────────────────────────────────────────
-- 64 lowercase hex, so a fitting id (digits) or a request id (uuid) can never
-- be stored where a hash belongs and resolved by a later GET.
do $$
begin
  insert into public.marshalled_fitting (user_id, content_hash, name, ship_type_id)
  values ('a0000000-0000-0000-0000-000000000000', '42', 'x', 1);
  raise exception 'a fitting id was accepted as a content hash';
exception when check_violation then
  null;
end $$;
do $$
begin
  insert into public.marshalled_fitting (user_id, content_hash, name, ship_type_id)
  values ('a0000000-0000-0000-0000-000000000000', '22222222-2222-2222-2222-222222222222', 'x', 1);
  raise exception 'a uuid was accepted as a content hash';
exception when check_violation then
  null;
end $$;
do $$
begin
  insert into public.marshalled_fitting (user_id, content_hash, name, ship_type_id)
  values ('a0000000-0000-0000-0000-000000000000',
          'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'x', 1);
  raise exception 'an upper-case hash was accepted; the routes lower-case before storing';
exception when check_violation then
  null;
end $$;

-- ── Owner reads own rows, nobody else's ───────────────────────────────────
set local role authenticated;
do $$
declare
  n int;
begin
  perform set_config('test.uid', 'a0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.marshalled_fitting;
  assert n = 1, format('alice sees %s rows, expected her 1', n);

  perform set_config('test.uid', 'b0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.marshalled_fitting;
  assert n = 2, format('bob sees %s rows, expected his 2', n);

  -- Signed out (no uid) sees nothing at all.
  perform set_config('test.uid', '', true);
  select count(*) into n from public.marshalled_fitting;
  assert n = 0, format('an anonymous read saw %s rows', n);
end $$;

-- ── authenticated cannot write, not even their own rows ──────────────────
-- No insert/update/delete policy AND no grant: the refusal is
-- insufficient_privilege before RLS is even consulted. A session that could
-- insert here could claim a fit left the game when it did not.
do $$
begin
  perform set_config('test.uid', 'a0000000-0000-0000-0000-000000000000', true);
  insert into public.marshalled_fitting (user_id, content_hash, name, ship_type_id)
  values ('a0000000-0000-0000-0000-000000000000',
          '3333333333333333333333333333333333333333333333333333333333333333', 'Smuggled', 1);
  raise exception 'authenticated inserted a marshalled fit';
exception when insufficient_privilege then
  null;
end $$;
do $$
begin
  perform set_config('test.uid', 'a0000000-0000-0000-0000-000000000000', true);
  update public.marshalled_fitting set name = 'Renamed'
    where content_hash = '1111111111111111111111111111111111111111111111111111111111111111';
  raise exception 'authenticated updated a marshalled fit';
exception when insufficient_privilege then
  null;
end $$;
do $$
begin
  perform set_config('test.uid', 'a0000000-0000-0000-0000-000000000000', true);
  delete from public.marshalled_fitting
    where content_hash = '1111111111111111111111111111111111111111111111111111111111111111';
  raise exception 'authenticated deleted a marshalled fit';
exception when insufficient_privilege then
  null;
end $$;
reset role;

-- ── Unlinking the source character keeps the fit ─────────────────────────
-- The whole point of an account-level row: marshal an alt's fits, then drop
-- the alt. The provenance goes null; the fit stays.
delete from public.registration where id = :'reg';
do $$
declare
  r record;
begin
  select * into r from public.marshalled_fitting
    where user_id = 'a0000000-0000-0000-0000-000000000000'
      and content_hash = '1111111111111111111111111111111111111111111111111111111111111111';
  assert found, 'the marshalled fit vanished with its source registration';
  assert r.source_registration_id is null, 'source_registration_id was not nulled';
  assert r.source_fitting_id = 42, 'the game id it had is still recorded';
end $$;

rollback;
