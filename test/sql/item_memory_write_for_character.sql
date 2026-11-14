-- SQL-level coverage for item_memory_write_for_character()
-- (supabase/migrations/20261111101913_item_memory_write_for_character.sql, docs/ship-memory.md "Speaking for a
-- mail's sender"): the write the mail auto-responder makes for a mail's
-- sender, on the service role.
--
--   * only the service role may call it;
--   * the named character, or a corporation it is in, must hold the item now —
--     never an alt of the same account, never a character in no registration;
--   * the version is the sender's account's own (written_by, closed_by), with
--     the author the tool passes;
--   * a stale based_on is refused, as in item_memory_write().
--
-- Run against a THROWAWAY database from the repo root (it creates stand-in
-- tables named after the real ones): DATABASE_URL='postgresql://…/throwaway'
-- pnpm run test:sql. Everything runs in one transaction and rolls back.
begin;

do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;

create schema if not exists auth;
create or replace function auth.uid() returns uuid
language sql stable
as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
create table auth.users (id uuid primary key);

grant usage on schema auth to authenticated, service_role;
grant usage on schema public to authenticated, service_role;
grant execute on function auth.uid() to authenticated, service_role;

-- Stand-ins carrying the columns holds_item() and the new function read.
create table public.registration (
  id uuid primary key,
  user_id uuid not null,
  character_id bigint,
  corporation_id bigint,
  updated_at timestamptz not null default now()
);
alter table public.registration enable row level security;
create policy "Users manage own characters" on public.registration
  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select on public.registration to authenticated;
grant all on public.registration to service_role;

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
grant all on public.character_asset_version to service_role;

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
grant all on public.corp_asset_version to service_role;

\i supabase/migrations/20261101090426_item_memory.sql
\i supabase/migrations/20261101220500_item_memory_reassembly.sql
\i supabase/migrations/20261111101913_item_memory_write_for_character.sql

-- alice flies character 90000001 and an alt, 90000002, on one account. The
-- Rifter 9001 is in 90000001's hangar, the Heron 9003 in the alt's. bob
-- (90000003) flies for corporation 2002, which holds the Badger 9002; alice
-- is in no corporation of ours.
insert into auth.users values
  ('a0000000-0000-0000-0000-000000000000'),
  ('b0000000-0000-0000-0000-000000000000');
insert into public.registration (id, user_id, character_id, corporation_id) values
  ('00000000-0000-0000-0000-0000000000aa', 'a0000000-0000-0000-0000-000000000000', 90000001, null),
  ('00000000-0000-0000-0000-0000000000ab', 'a0000000-0000-0000-0000-000000000000', 90000002, null),
  ('00000000-0000-0000-0000-0000000000bb', 'b0000000-0000-0000-0000-000000000000', 90000003, 2002);
insert into public.character_asset_version (item_id, registration_id, type_id) values
  (9001, '00000000-0000-0000-0000-0000000000aa', 587),
  (9003, '00000000-0000-0000-0000-0000000000ab', 605);
insert into public.corp_asset_version (item_id, corporation_id, type_id)
values (9002, 2002, 648);

-- ── Only the service role calls it ────────────────────────────────────────
do $$
begin
  assert not has_function_privilege('anon',
    'public.item_memory_write_for_character(bigint, bigint, text, bigint, text)', 'execute'),
    'anon can name any character as the writer';
  assert not has_function_privilege('authenticated',
    'public.item_memory_write_for_character(bigint, bigint, text, bigint, text)', 'execute'),
    'a signed-in user can name any character as the writer';
  assert has_function_privilege('service_role',
    'public.item_memory_write_for_character(bigint, bigint, text, bigint, text)', 'execute'),
    'the service role cannot call it';
end $$;

set local role service_role;

-- ── The sender's own hangar, written as the sender's account ──────────────
do $$
declare
  v1 bigint;
  v2 bigint;
  r public.item_memory_over_time;
begin
  v1 := public.item_memory_write_for_character(90000001, 9001, 'Built at Rens.', null, 'Aura via EVE mail 5');
  select * into r from public.item_memory_over_time where id = v1;
  assert r.is_current and r.type_id = 587 and r.author = 'Aura via EVE mail 5'
     and r.written_by = 'a0000000-0000-0000-0000-000000000000' and r.closed_by is null,
       'the first version is the sender''s, with the author the tool passed';

  -- A first write on an item that has a memory is stale.
  begin
    perform public.item_memory_write_for_character(90000001, 9001, 'Again.', null);
    raise exception 'a second first write landed';
  exception when sqlstate 'PT409' then null;
  end;
  -- So is a based_on that is not the current version.
  begin
    perform public.item_memory_write_for_character(90000001, 9001, 'Again.', v1 + 1000);
    raise exception 'a stale based_on landed';
  exception when sqlstate 'PT409' then null;
  end;

  v2 := public.item_memory_write_for_character(90000001, 9001, 'Built at Rens. Hauled to Hek.', v1);
  select * into r from public.item_memory_over_time where id = v1;
  assert not r.is_current and r.closed_by = 'a0000000-0000-0000-0000-000000000000',
    'the superseded version is closed by the sender''s account';
  select * into r from public.item_memory_over_time where id = v2;
  assert r.is_current and r.author = 'mail', 'the default author is mail';
end $$;

-- ── Never an alt, a stranger or someone else's corporation ────────────────
do $$
begin
  begin
    perform public.item_memory_write_for_character(90000001, 9003, 'I am a Heron.', null);
    raise exception 'a character wrote the memory of an alt''s item';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.item_memory_write_for_character(90000001, 9002, 'I am a Badger.', null);
    raise exception 'a character wrote the memory of a corporation item it is not in';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.item_memory_write_for_character(99999999, 9001, 'Not registered.', null);
    raise exception 'an unregistered character wrote a memory';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.item_memory_write_for_character(90000001, 424242, 'Nothing.', null);
    raise exception 'a memory was written for an item nobody holds';
  exception when insufficient_privilege then null;
  end;
end $$;

-- ── The corporation's item, through a member ──────────────────────────────
do $$
declare
  v bigint;
  r public.item_memory_over_time;
begin
  v := public.item_memory_write_for_character(90000003, 9002, 'Corp Badger.', null, 'EVE mail 6');
  select * into r from public.item_memory_over_time where id = v;
  assert r.type_id = 648 and r.written_by = 'b0000000-0000-0000-0000-000000000000',
    'a corporation item is written as the member''s account';
end $$;

-- ── A former holder cannot write ──────────────────────────────────────────
do $$
begin
  update public.character_asset_version set is_current = false where item_id = 9001;
  begin
    perform public.item_memory_write_for_character(90000001, 9001, 'Sold.', null);
    raise exception 'a former holder wrote';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;

-- ── The sender reads what was written for them, as their own ──────────────
set local role authenticated;
do $$
declare
  n int;
begin
  perform set_config('test.uid', 'a0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.item_memory_over_time where item_id = 9001;
  assert n = 2, 'alice reads both versions written for her';
end $$;

rollback;
