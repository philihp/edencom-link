-- SQL-level coverage for ship memory's storage
-- (supabase/migrations/20261101090426_item_memory.sql, docs/ship-memory.md
-- "Storage"): the rules Postgres enforces rather than the app does.
--
--   * holds_item() is ownership, not visibility: a share recipient sees the
--     hull's asset row but holds nothing;
--   * only the holder writes, and only on top of the version they read;
--   * the sale: at the buyer's first sighting the seller loses write and the
--     buyer gains both, the seller keeps the versions they wrote, and the
--     buyer never sees the seller's superseded ones;
--   * a corporation hull is every member's, and nobody else's;
--   * a direct table write can do no more than item_memory_write() does;
--   * the body's bounds, and an author's account deletion keeping the text.
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

-- Stand-ins carrying the columns and the policies holds_item() reads. The
-- character side also shows a share recipient the rows shared with them, as
-- the real table's share policy does: that is what makes "seeing a row is not
-- holding it" testable.
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

create table public.test_asset_share (item_id bigint not null, user_id uuid not null);
grant select on public.test_asset_share to authenticated;

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
create policy "Recipients read shared assets" on public.character_asset_version
  for select to authenticated
  using (is_current and item_id in (select s.item_id from public.test_asset_share s where s.user_id = (select auth.uid())));
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

-- alice holds the Rifter 9001 in a character hangar; carol is shown it by a
-- share; bob and dave fly for corporation 2002, which holds the Badger 9002.
insert into auth.users values
  ('a0000000-0000-0000-0000-000000000000'),
  ('b0000000-0000-0000-0000-000000000000'),
  ('c0000000-0000-0000-0000-000000000000'),
  ('d0000000-0000-0000-0000-000000000000');
insert into public.registration values
  ('00000000-0000-0000-0000-0000000000aa', 'a0000000-0000-0000-0000-000000000000', null),
  ('00000000-0000-0000-0000-0000000000bb', 'b0000000-0000-0000-0000-000000000000', 2002),
  ('00000000-0000-0000-0000-0000000000cc', 'c0000000-0000-0000-0000-000000000000', null),
  ('00000000-0000-0000-0000-0000000000dd', 'd0000000-0000-0000-0000-000000000000', 2002);
insert into public.character_asset_version (item_id, registration_id, type_id)
values (9001, '00000000-0000-0000-0000-0000000000aa', 587);
insert into public.corp_asset_version (item_id, corporation_id, type_id)
values (9002, 2002, 648);
insert into public.test_asset_share values (9001, 'c0000000-0000-0000-0000-000000000000');

create function pg_temp.as_user(uid text) returns void
language sql as $$ select set_config('test.uid', uid, true) $$;

set local role authenticated;

-- ── holds_item() is ownership, not visibility ─────────────────────────────
do $$
declare
  n int;
begin
  perform pg_temp.as_user('a0000000-0000-0000-0000-000000000000');
  assert public.holds_item(9001), 'alice holds a hull in alice''s own hangar';
  assert not public.holds_item(9002), 'alice holds the hull of a corporation alice is not in';

  perform pg_temp.as_user('c0000000-0000-0000-0000-000000000000');
  select count(*) into n from public.character_asset_version where item_id = 9001;
  assert n = 1, 'the stand-in share should show carol the hull, or the next line proves nothing';
  assert not public.holds_item(9001), 'carol sees the hull through a share, and must not hold it';

  perform pg_temp.as_user('b0000000-0000-0000-0000-000000000000');
  assert public.holds_item(9002), 'bob holds the hull of bob''s corporation';
  assert not public.holds_item(9001), 'bob holds alice''s hull';

  perform pg_temp.as_user('');
  assert not public.holds_item(9001), 'signed out holds nothing';
end $$;

-- ── Only the holder writes ────────────────────────────────────────────────
do $$
begin
  perform pg_temp.as_user('c0000000-0000-0000-0000-000000000000');
  begin
    perform public.item_memory_write(9001, 'I am a Rifter.', null);
    raise exception 'a share recipient wrote the memory';
  exception when insufficient_privilege then null;
  end;
  -- Nor by going round the function.
  begin
    insert into public.item_memory_over_time (item_id, type_id, body) values (9001, 587, 'I am a Rifter.');
    raise exception 'a share recipient inserted a memory directly';
  exception when insufficient_privilege then null;
  end;
end $$;

-- ── The holder writes, on top of the version they read ────────────────────
do $$
declare
  v1 bigint;
  v2 bigint;
  r public.item_memory_over_time;
begin
  perform pg_temp.as_user('a0000000-0000-0000-0000-000000000000');
  v1 := public.item_memory_write(9001, 'Built at Rens. Smelled of fresh weld.', null, 'Claude');
  select * into r from public.item_memory_over_time where id = v1;
  assert r.is_current and r.type_id = 587 and r.author = 'Claude'
     and r.written_by = 'a0000000-0000-0000-0000-000000000000'
     and r.closed_by is null,
    format('first version stored wrong: %s', row_to_json(r));

  -- A second first write: the caller never read v1.
  begin
    perform public.item_memory_write(9001, 'Something else.', null);
    raise exception 'a write that never read the memory replaced it';
  exception when sqlstate 'PT409' then null;
  end;
  -- A version that is not the current one.
  begin
    perform public.item_memory_write(9001, 'Something else.', v1 + 1000);
    raise exception 'a write based on a version that does not exist landed';
  exception when sqlstate 'PT409' then null;
  end;

  v2 := public.item_memory_write(9001, 'Built at Rens. Hauled Tritanium to Hek.', v1);
  select * into r from public.item_memory_over_time where id = v1;
  assert not r.is_current and r.closed_by = 'a0000000-0000-0000-0000-000000000000'
     and r.valid_until = (select valid_from from public.item_memory_over_time where id = v2),
    format('v1 should be closed by alice on v2''s instant: %s', row_to_json(r));
  -- A blank author falls back to mcp.
  assert (select author from public.item_memory_over_time where id = v2) = 'mcp', 'author defaults to mcp';

  -- And v1, already superseded, cannot be built on again.
  begin
    perform public.item_memory_write(9001, 'A rewrite from an old read.', v1);
    raise exception 'a write based on a superseded version landed';
  exception when sqlstate 'PT409' then null;
  end;

  assert (select count(*) from public.item_memory where item_id = 9001) = 1, 'one current memory';
end $$;

-- ── Who reads what, before the sale ───────────────────────────────────────
do $$
declare
  n int;
begin
  perform pg_temp.as_user('a0000000-0000-0000-0000-000000000000');
  select count(*) into n from public.item_memory_over_time;
  assert n = 2, format('alice sees %s versions, expected alice''s 2', n);

  -- The share recipient reads the memory on the share page, through the
  -- service role (PR 5), never through this table.
  perform pg_temp.as_user('c0000000-0000-0000-0000-000000000000');
  select count(*) into n from public.item_memory_over_time;
  assert n = 0, format('carol sees %s versions', n);

  perform pg_temp.as_user('b0000000-0000-0000-0000-000000000000');
  select count(*) into n from public.item_memory_over_time where item_id = 9001;
  assert n = 0, format('bob sees %s versions of a hull bob does not hold', n);

  perform pg_temp.as_user('');
  select count(*) into n from public.item_memory_over_time;
  assert n = 0, format('signed out sees %s versions', n);
end $$;

-- ── The sale ──────────────────────────────────────────────────────────────
-- bob's extract first lists the Rifter: the claim closes alice's row and
-- opens bob's, as character_asset_claim() does on the service role.
reset role;
update public.character_asset_version set is_current = false, valid_until = now() where item_id = 9001 and is_current;
insert into public.character_asset_version (item_id, registration_id, type_id)
values (9001, '00000000-0000-0000-0000-0000000000bb', 587);
set local role authenticated;

do $$
declare
  v2 bigint;
  v3 bigint;
  n int;
begin
  perform pg_temp.as_user('b0000000-0000-0000-0000-000000000000');
  -- The buyer reads the current text, which alice wrote, and only that.
  select id into v2 from public.item_memory where item_id = 9001;
  assert v2 is not null, 'bob should read the memory of the hull bob now holds';
  select count(*) into n from public.item_memory_over_time where item_id = 9001;
  assert n = 1, format('bob sees %s versions; alice''s superseded one must stay alice''s', n);

  -- And writes on top of it: closing a version written by someone else is
  -- what closed_by is for (the UPDATE's new row must stay readable to bob).
  v3 := public.item_memory_write(9001, 'Before you, I hauled for a Minmatar out of Rens. Now I fly for you.', v2);
  select count(*) into n from public.item_memory_over_time where item_id = 9001;
  assert n = 2, format('bob sees %s versions, expected the one bob closed and bob''s own', n);

  perform pg_temp.as_user('a0000000-0000-0000-0000-000000000000');
  assert not public.holds_item(9001), 'the seller still holds the hull';
  begin
    perform public.item_memory_write(9001, 'Still mine.', v3);
    raise exception 'the seller wrote after the sale';
  exception when insufficient_privilege then null;
  end;
  -- The seller keeps every version the seller wrote, and nothing written after.
  select count(*) into n from public.item_memory_over_time where item_id = 9001;
  assert n = 2, format('alice sees %s versions, expected alice''s own 2', n);
  assert not exists (select 1 from public.item_memory_over_time where id = v3), 'alice reads the buyer''s version';
  assert not exists (select 1 from public.item_memory where item_id = 9001), 'alice reads the current memory';
end $$;

-- ── A corporation hull is every member's ──────────────────────────────────
do $$
declare
  v1 bigint;
  v2 bigint;
begin
  perform pg_temp.as_user('d0000000-0000-0000-0000-000000000000');
  v1 := public.item_memory_write(9002, 'A Badger. I count in m³.', null);

  perform pg_temp.as_user('b0000000-0000-0000-0000-000000000000');
  assert exists (select 1 from public.item_memory where id = v1), 'bob reads a memory a corpmate wrote';
  v2 := public.item_memory_write(9002, 'A Badger. 412,000 m³ and counting.', v1);
  assert (select type_id from public.item_memory_over_time where id = v2) = 648, 'type comes from the corp row';

  perform pg_temp.as_user('a0000000-0000-0000-0000-000000000000');
  assert not exists (select 1 from public.item_memory_over_time where item_id = 9002), 'alice reads a corp hull''s memory';
  begin
    perform public.item_memory_write(9002, 'Not mine.', v2);
    raise exception 'an outsider wrote a corp hull''s memory';
  exception when insufficient_privilege then null;
  end;
end $$;

-- ── A direct write can do no more than the function ───────────────────────
do $$
declare
  n int;
begin
  perform pg_temp.as_user('b0000000-0000-0000-0000-000000000000');
  -- The author account is the caller, never named.
  begin
    insert into public.item_memory_over_time (item_id, type_id, body, written_by)
    values (9001, 587, 'Forged.', 'a0000000-0000-0000-0000-000000000000');
    raise exception 'an insert named its author account';
  exception when insufficient_privilege then null;
  end;
  -- A second current version collides.
  begin
    insert into public.item_memory_over_time (item_id, type_id, body) values (9001, 587, 'A second current text.');
    raise exception 'two current memories for one hull';
  exception when unique_violation then null;
  end;
  -- The text of a version never changes.
  begin
    update public.item_memory_over_time set body = 'Rewritten history.' where item_id = 9001;
    raise exception 'a version''s text was edited in place';
  exception when insufficient_privilege then null;
  end;
  -- A close must be signed by the closer.
  begin
    update public.item_memory_over_time set is_current = false where item_id = 9001 and is_current;
    raise exception 'a close left closed_by empty';
  exception when insufficient_privilege then null;
  end;
  -- A closed version is never reopened.
  update public.item_memory_over_time set is_current = true, closed_by = (select auth.uid())
   where item_id = 9001 and not is_current;
  get diagnostics n = row_count;
  assert n = 0, format('%s closed versions reopened', n);
  -- Nothing is deleted.
  begin
    delete from public.item_memory_over_time where item_id = 9001;
    raise exception 'a version was deleted';
  exception when insufficient_privilege then null;
  end;
end $$;

-- ── The body's bounds ─────────────────────────────────────────────────────
do $$
declare
  cur bigint;
begin
  perform pg_temp.as_user('b0000000-0000-0000-0000-000000000000');
  select id into cur from public.item_memory where item_id = 9001;
  begin
    perform public.item_memory_write(9001, '   ', cur);
    raise exception 'a blank memory was stored';
  exception when check_violation then null;
  end;
  begin
    perform public.item_memory_write(9001, repeat('x', 20001), cur);
    raise exception 'a memory over 20,000 characters was stored';
  exception when check_violation then null;
  end;
  -- The refused writes rolled back their close, too.
  assert (select id from public.item_memory where item_id = 9001) = cur, 'a refused write closed the current version';
  perform public.item_memory_write(9001, repeat('x', 20000), cur);
end $$;

-- ── An author's account goes; the hull keeps the text ─────────────────────
reset role;
delete from auth.users where id = 'a0000000-0000-0000-0000-000000000000';
do $$
begin
  assert (select count(*) from public.item_memory_over_time where item_id = 9001) = 4,
    'deleting an author''s account removed versions';
  assert not exists (
    select 1 from public.item_memory_over_time
    where written_by = 'a0000000-0000-0000-0000-000000000000'
       or closed_by = 'a0000000-0000-0000-0000-000000000000'
  ), 'a deleted account is still named';
end $$;

rollback;
