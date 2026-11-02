-- SQL-level coverage for ship memory's reassembly storage
-- (supabase/migrations/20261101220500_item_memory_reassembly.sql,
-- docs/ship-memory.md "Reassembly"): the rules Postgres enforces rather than
-- the app does.
--
--   * item_memory_carry() moves a memory onto a new hull in one transaction:
--     the new version keeps the old author account and the body, is signed
--     'reassembly' and names the id it came from; the old id's version is
--     closed by nobody; the pack is resolved;
--   * it refuses a hull that already has a memory, a hull nobody holds, a
--     hull of another type, a pack that is not pending, and any caller but
--     the service role;
--   * the lineage pointer is copied onto every later version the holder
--     writes, and a direct write cannot name it;
--   * the holder of the new hull reads the carried text and writes on top of
--     it; an owner reads their own pending packs and nobody else's.
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
create table auth.users (id uuid primary key);

grant usage on schema auth to authenticated, service_role;
grant usage on schema public to authenticated, service_role;
grant execute on function auth.uid() to authenticated, service_role;

-- Stand-ins carrying the columns holds_item() and the carry read.
create table public.registration (
  id uuid primary key,
  user_id uuid not null,
  corporation_id bigint
);
alter table public.registration enable row level security;
create policy "Users manage own characters" on public.registration
  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select on public.registration to authenticated;

create or replace function public.my_corporation_ids()
returns setof bigint
language sql
stable
as $$
  select r.corporation_id
  from public.registration r
  where r.user_id = (select auth.uid()) and r.corporation_id is not null;
$$;

create table public.character_asset_version (
  id bigint generated always as identity primary key,
  item_id bigint not null,
  registration_id uuid not null references public.registration (id),
  type_id bigint not null,
  is_current boolean not null default true,
  valid_from timestamptz not null default now(),
  valid_until timestamptz not null default now()
);
create unique index character_asset_version_current_item_idx
  on public.character_asset_version (item_id) where is_current;
alter table public.character_asset_version enable row level security;
create policy "Users read own assets" on public.character_asset_version
  for select to authenticated
  using (registration_id in (select id from public.registration where user_id = (select auth.uid())));
grant select on public.character_asset_version to authenticated;

create table public.corp_asset_version (
  id bigint generated always as identity primary key,
  item_id bigint not null,
  corporation_id bigint not null,
  type_id bigint not null,
  is_current boolean not null default true,
  valid_from timestamptz not null default now(),
  valid_until timestamptz not null default now()
);
create unique index corp_asset_version_current_item_idx
  on public.corp_asset_version (item_id) where is_current;
alter table public.corp_asset_version enable row level security;
create policy "Users read assets for own corps" on public.corp_asset_version
  for select to authenticated
  using (corporation_id in (select public.my_corporation_ids()));
grant select on public.corp_asset_version to authenticated;

\i supabase/migrations/20261101090426_item_memory.sql
\i supabase/migrations/20261101220500_item_memory_reassembly.sql

-- alice holds Rifter 9001; bob flies for corporation 2002, which holds
-- Wreathe 9002. carol is nobody's corpmate.
insert into auth.users values
  ('a0000000-0000-0000-0000-000000000000'),
  ('b0000000-0000-0000-0000-000000000000'),
  ('c0000000-0000-0000-0000-000000000000');
insert into public.registration values
  ('00000000-0000-0000-0000-0000000000aa', 'a0000000-0000-0000-0000-000000000000', null),
  ('00000000-0000-0000-0000-0000000000bb', 'b0000000-0000-0000-0000-000000000000', 2002),
  ('00000000-0000-0000-0000-0000000000cc', 'c0000000-0000-0000-0000-000000000000', null);
insert into public.character_asset_version (item_id, registration_id, type_id)
values (9001, '00000000-0000-0000-0000-0000000000aa', 587);
insert into public.corp_asset_version (item_id, corporation_id, type_id)
values (9002, 2002, 653);

create function pg_temp.as_user(uid text) returns void
language sql as $$ select set_config('test.uid', uid, true) $$;

-- alice writes the Rifter's memory twice.
set local role authenticated;
do $$
declare
  v1 bigint;
begin
  perform pg_temp.as_user('a0000000-0000-0000-0000-000000000000');
  v1 := public.item_memory_write(9001, 'Built at Rens. Smelled of fresh weld.', null, 'Claude');
  perform public.item_memory_write(9001, 'Built at Rens. Hauled Tritanium to Hek.', v1, 'Claude');
end $$;
reset role;

-- ── The pack ──────────────────────────────────────────────────────────────
-- alice repackages the Rifter: the extract closes 9001 and records the pack,
-- as recordReassembly does on the service role.
update public.character_asset_version set is_current = false, valid_until = now() where item_id = 9001;
insert into public.item_memory_pack (item_id, type_id, registration_id, stack_item_id, location_id, packed_at)
values (9001, 587, '00000000-0000-0000-0000-0000000000aa', 7001, 60004588, now());

set local role authenticated;
do $$
declare
  n int;
begin
  perform pg_temp.as_user('a0000000-0000-0000-0000-000000000000');
  select count(*) into n from public.item_memory_pack;
  assert n = 1, format('alice sees %s packs, expected alice''s 1', n);
  -- The memory is still alice's to read: she wrote it.
  select count(*) into n from public.item_memory_over_time where item_id = 9001;
  assert n = 2, format('alice sees %s versions of the packed hull', n);

  perform pg_temp.as_user('b0000000-0000-0000-0000-000000000000');
  select count(*) into n from public.item_memory_pack;
  assert n = 0, format('bob sees %s of alice''s packs', n);

  -- Nobody but the service role carries.
  begin
    perform public.item_memory_carry(9001, 9002);
    raise exception 'an authenticated caller ran the carry';
  exception when insufficient_privilege then null;
  end;
  perform pg_temp.as_user('');
  select count(*) into n from public.item_memory_pack;
  assert n = 0, format('signed out sees %s packs', n);
end $$;
reset role;

-- ── The carry refuses what it should ──────────────────────────────────────
do $$
begin
  -- No hull holds 9003 yet.
  begin
    perform public.item_memory_carry(9001, 9003, 1);
    raise exception 'carried onto a hull nobody holds';
  exception when no_data_found then null;
  end;
  -- 9002 is a Wreathe; the memory belongs to a Rifter.
  begin
    perform public.item_memory_carry(9001, 9002, 1);
    raise exception 'carried a Rifter''s memory onto a Wreathe';
  exception when invalid_parameter_value then null;
  end;
  -- 9002 has no memory to carry.
  begin
    perform public.item_memory_carry(9002, 9001);
    raise exception 'carried a memory that does not exist';
  exception when no_data_found then null;
  end;
  -- Onto itself.
  begin
    perform public.item_memory_carry(9001, 9001);
    raise exception 'carried a memory onto its own item';
  exception when invalid_parameter_value then null;
  end;
  assert (select count(*) from public.item_memory_over_time) = 2, 'a refused carry left a version behind';
  assert (select resolved_at from public.item_memory_pack where id = 1) is null, 'a refused carry resolved the pack';
end $$;

-- ── The carry ─────────────────────────────────────────────────────────────
-- alice assembles a Rifter from the stack: hull 9003 debuts, and the extract
-- matches it to the pack.
insert into public.character_asset_version (item_id, registration_id, type_id)
values (9003, '00000000-0000-0000-0000-0000000000aa', 587);

do $$
declare
  v_new bigint;
  r public.item_memory_over_time;
  old public.item_memory_over_time;
begin
  -- The wrong pack id is refused before anything moves.
  begin
    perform public.item_memory_carry(9001, 9003, 999);
    raise exception 'carried against a pack that does not exist';
  exception when no_data_found then null;
  end;

  v_new := public.item_memory_carry(9001, 9003, 1);
  select * into r from public.item_memory_over_time where id = v_new;
  assert r.item_id = 9003 and r.is_current and r.type_id = 587
     and r.body = 'Built at Rens. Hauled Tritanium to Hek.'
     and r.author = 'reassembly'
     and r.written_by = 'a0000000-0000-0000-0000-000000000000'
     and r.closed_by is null
     and r.carried_from_item_id = 9001,
    format('the carried version is wrong: %s', row_to_json(r));

  select * into old from public.item_memory_over_time where item_id = 9001 and body = r.body;
  assert not old.is_current and old.closed_by is null and old.valid_until = r.valid_from,
    format('the old id''s version should be closed by nobody on the carry''s instant: %s', row_to_json(old));
  assert (select count(*) from public.item_memory where item_id = 9001) = 0, 'the old id still has a current memory';

  assert (select resolved_at = r.valid_from and resolved_item_id = 9003 from public.item_memory_pack where id = 1),
    'the pack was not resolved onto the new hull';

  -- Twice is refused: the new hull has a memory now, and the pack is spent.
  begin
    perform public.item_memory_carry(9001, 9003, 1);
    raise exception 'carried twice';
  exception when no_data_found then null;
  end;
end $$;

-- ── The holder reads the carried text and writes on top of it ────────────
set local role authenticated;
do $$
declare
  cur bigint;
  v_next bigint;
  r public.item_memory_over_time;
begin
  perform pg_temp.as_user('a0000000-0000-0000-0000-000000000000');
  select id into cur from public.item_memory where item_id = 9003;
  assert cur is not null, 'the holder should read the carried memory on the new hull';
  assert (select carried_from_item_id from public.item_memory where item_id = 9003) = 9001,
    'the current row should name where the memory came from';

  v_next := public.item_memory_write(9003, 'Built at Rens. Repackaged once, and none the worse for it.', cur, 'Claude');
  select * into r from public.item_memory_over_time where id = v_next;
  assert r.carried_from_item_id = 9001,
    format('the lineage pointer was not copied onto the next version: %s', row_to_json(r));
  assert r.author = 'Claude' and r.written_by = 'a0000000-0000-0000-0000-000000000000',
    'an ordinary write after a carry is still the writer''s';

  -- A direct write cannot name the pointer.
  begin
    insert into public.item_memory_over_time (item_id, type_id, body, carried_from_item_id)
    values (9003, 587, 'Forged lineage.', 4242);
    raise exception 'a direct insert named carried_from_item_id';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- ── A first write with no lineage stays blank ─────────────────────────────
set local role authenticated;
do $$
declare
  v1 bigint;
begin
  perform pg_temp.as_user('b0000000-0000-0000-0000-000000000000');
  v1 := public.item_memory_write(9002, 'A Wreathe. I count in m³.', null);
  assert (select carried_from_item_id from public.item_memory_over_time where id = v1) is null,
    'a hull with no lineage got a pointer';
end $$;
reset role;

-- ── A corporation's pack is every member's to see ─────────────────────────
update public.corp_asset_version set is_current = false, valid_until = now() where item_id = 9002;
insert into public.item_memory_pack (item_id, type_id, corporation_id, stack_item_id, location_id, packed_at)
values (9002, 653, 2002, 7002, 60004588, now());

set local role authenticated;
do $$
declare
  n int;
begin
  perform pg_temp.as_user('b0000000-0000-0000-0000-000000000000');
  select count(*) into n from public.item_memory_pack where item_id = 9002;
  assert n = 1, format('bob sees %s packs of bob''s corporation', n);
  perform pg_temp.as_user('c0000000-0000-0000-0000-000000000000');
  select count(*) into n from public.item_memory_pack;
  assert n = 0, format('carol sees %s packs', n);
  -- Nobody but the service role writes a pack.
  begin
    insert into public.item_memory_pack (item_id, type_id, registration_id, packed_at)
    values (9001, 587, '00000000-0000-0000-0000-0000000000cc', now());
    raise exception 'an authenticated caller inserted a pack';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- The owner-kind check: exactly one owner.
do $$
begin
  begin
    insert into public.item_memory_pack (item_id, type_id, packed_at) values (1, 1, now());
    raise exception 'a pack with no owner was stored';
  exception when check_violation then null;
  end;
  begin
    insert into public.item_memory_pack (item_id, type_id, registration_id, corporation_id, packed_at)
    values (1, 1, '00000000-0000-0000-0000-0000000000aa', 2002, now());
    raise exception 'a pack with two owners was stored';
  exception when check_violation then null;
  end;
end $$;

rollback;
