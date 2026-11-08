-- SQL-level coverage for planner_stock_target (the industry planner's stock
-- directive): the rules Postgres enforces rather than the app does.
--
--   * an owner reads, writes and deletes their own rows and nobody else's;
--   * a row cannot be written under another user's id;
--   * a quantity below zero is refused;
--   * (user_id, type_id) is the identity: one line per type per account.
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

-- The table under test, verbatim from the migration minus the auth.users FK.
create table public.planner_stock_target (
  user_id    uuid    not null,
  type_id    bigint  not null,
  backup     integer not null default 0 check (backup >= 0),
  home       integer not null default 0 check (home >= 0),
  jita       integer not null default 0 check (jita >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, type_id)
);
alter table public.planner_stock_target enable row level security;
create policy "Users manage own stock targets"
  on public.planner_stock_target
  for all
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
grant select, insert, update, delete on public.planner_stock_target to authenticated;
grant usage on schema public to authenticated;

-- Alice writes two targets; Bob writes one.
set local role authenticated;
select set_config('test.uid', '11111111-1111-1111-1111-111111111111', true);
insert into public.planner_stock_target (user_id, type_id, backup, home, jita)
values ('11111111-1111-1111-1111-111111111111', 648, 0, 20, 100),
       ('11111111-1111-1111-1111-111111111111', 34, 2000, 0, 0);

select set_config('test.uid', '22222222-2222-2222-2222-222222222222', true);
insert into public.planner_stock_target (user_id, type_id, backup)
values ('22222222-2222-2222-2222-222222222222', 648, 5);

-- Bob sees only his row.
do $$
declare n int;
begin
  select count(*) into n from public.planner_stock_target;
  if n <> 1 then raise exception 'bob sees % rows, expected 1', n; end if;
end $$;

-- Bob cannot write a row under Alice's id.
do $$
begin
  insert into public.planner_stock_target (user_id, type_id)
  values ('11111111-1111-1111-1111-111111111111', 35);
  raise exception 'bob wrote a row under alice''s id';
exception when insufficient_privilege then null;
end $$;

-- Bob's delete of Alice's type touches nothing of hers.
delete from public.planner_stock_target where type_id = 648;
select set_config('test.uid', '11111111-1111-1111-1111-111111111111', true);
do $$
declare n int;
begin
  select count(*) into n from public.planner_stock_target where type_id = 648;
  if n <> 1 then raise exception 'bob''s delete removed alice''s row'; end if;
end $$;

-- A quantity below zero is refused.
do $$
begin
  update public.planner_stock_target set home = -1 where type_id = 648;
  raise exception 'a negative quantity was stored';
exception when check_violation then null;
end $$;

-- One line per type per account.
do $$
begin
  insert into public.planner_stock_target (user_id, type_id)
  values ('11111111-1111-1111-1111-111111111111', 648);
  raise exception 'a second line for one type was stored';
exception when unique_violation then null;
end $$;

rollback;
