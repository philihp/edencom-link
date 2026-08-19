-- SQL-level coverage for fitting_write_log's request_id — the constraint that
-- makes "a restore key is used once" true (docs/fitting-fuse.md).
--
-- This is in SQL rather than node:test because the rule is a database
-- constraint, and the branch that matters is the one the application code
-- cannot cover: two PUTs racing for the same key. The route reads the log
-- first, but that read is only the fast path — between it and the insert there
-- is a window, and the partial unique index is what closes it. Testing the
-- read would prove nothing about the race; testing the index proves the thing
-- the design actually leans on.
--
-- Run against a THROWAWAY database (it creates stand-in tables named after the
-- real ones in `public`) from the repo root:
--
--   initdb -D /tmp/pg && pg_ctl -D /tmp/pg -o '-k /tmp -p 55432' start
--   createdb -h /tmp -p 55432 fwl
--   DATABASE_URL='postgresql://…/fwl' pnpm run test:sql
--
-- Everything runs in one transaction and rolls back, so nothing is left behind.
begin;

-- A stand-in with the columns this test touches. The real table (schema.sql)
-- carries the whole fit body and foreign keys to auth.users and registration;
-- none of that participates in the uniqueness rule.
create table public.fitting_write_log (
  id bigint generated always as identity primary key,
  registration_id uuid not null,
  op text not null check (op in ('create', 'delete')),
  fitting_id bigint,
  request_id uuid,
  content_hash text not null,
  status text not null check (status in ('pending', 'ok', 'error')),
  created_at timestamptz not null default now()
);

-- The index under test, verbatim from the migration.
create unique index fitting_write_log_request_id_idx
  on public.fitting_write_log (request_id) where request_id is not null;

\set reg '11111111-1111-1111-1111-111111111111'
\set key '22222222-2222-2222-2222-222222222222'

-- A first restore claims the key.
insert into public.fitting_write_log (registration_id, op, request_id, content_hash, status)
values (:'reg', 'create', :'key', 'hash-a', 'pending');

-- ── The key is spent, whatever became of the attempt ─────────────────────
--
-- Checked at all three statuses, because the route treats them alike and the
-- reasons differ: 'ok' is a retry of a completed write, 'pending' is a crashed
-- or in-flight one, 'error' is a failed one. In every case the id has been
-- used and the caller should mint another.

-- 'pending' holder: a second insert on the same key is rejected.
do $$
begin
  insert into public.fitting_write_log (registration_id, op, request_id, content_hash, status)
  values ('11111111-1111-1111-1111-111111111111', 'create',
          '22222222-2222-2222-2222-222222222222', 'hash-b', 'pending');
  raise exception 'a second insert reused a pending request id';
exception when unique_violation then
  null;
end $$;

-- Same once the first attempt has completed.
update public.fitting_write_log set status = 'ok', fitting_id = 4242
  where request_id = :'key';

do $$
begin
  insert into public.fitting_write_log (registration_id, op, request_id, content_hash, status)
  values ('11111111-1111-1111-1111-111111111111', 'create',
          '22222222-2222-2222-2222-222222222222', 'hash-b', 'pending');
  raise exception 'a second insert reused a completed request id';
exception when unique_violation then
  null;
end $$;

-- And once it has failed: a spent key is spent, not recycled.
update public.fitting_write_log set status = 'error', fitting_id = null
  where request_id = :'key';

do $$
begin
  insert into public.fitting_write_log (registration_id, op, request_id, content_hash, status)
  values ('11111111-1111-1111-1111-111111111111', 'create',
          '22222222-2222-2222-2222-222222222222', 'hash-b', 'pending');
  raise exception 'a second insert reused a failed request id';
exception when unique_violation then
  null;
end $$;

-- ── The key is global, not per character ─────────────────────────────────
-- A uuid is unique by construction, so scoping the index per registration
-- would only let a confused client's collision through somewhere else.
do $$
begin
  insert into public.fitting_write_log (registration_id, op, request_id, content_hash, status)
  values ('33333333-3333-3333-3333-333333333333', 'create',
          '22222222-2222-2222-2222-222222222222', 'hash-c', 'pending');
  raise exception 'another character reused the same request id';
exception when unique_violation then
  null;
end $$;

-- ── Deletes, and rows predating the column, carry no key ─────────────────
-- Null is "not addressed by a request id", and any number of rows may be that:
-- every delete, plus every row written before the column existed. What permits
-- them is that a Postgres unique index treats nulls as distinct — the `where`
-- clause only keeps the index to the rows that have keys. Spelled out because
-- the tempting "tighten this up" edit is `nulls not distinct`, which would make
-- the second delete below collide and break archiving outright; this assertion
-- is the guard against it.
insert into public.fitting_write_log (registration_id, op, fitting_id, content_hash, status)
values (:'reg', 'delete', 10, 'hash-d', 'ok'),
       (:'reg', 'delete', 11, 'hash-e', 'ok'),
       (:'reg', 'delete', 12, 'hash-f', 'ok');

do $$
declare
  keyless int;
begin
  select count(*) into keyless from public.fitting_write_log where request_id is null;
  assert keyless = 3, format('expected 3 keyless rows, got %s', keyless);
end $$;

-- ── A fresh key is always available ──────────────────────────────────────
-- The refusal above has to be specific to the reused id, not to the character
-- or to having written before.
insert into public.fitting_write_log (registration_id, op, request_id, content_hash, status)
values (:'reg', 'create', '44444444-4444-4444-4444-444444444444', 'hash-b', 'pending');

do $$
declare
  keyed int;
begin
  select count(*) into keyed from public.fitting_write_log where request_id is not null;
  assert keyed = 2, format('expected 2 keyed rows, got %s', keyed);
end $$;

rollback;
