-- SQL-level coverage for migration 20261119091512_ledger_check.sql (ledger
-- stage 1, docs/ledger/stage-1.md): corp_wallet, ledger_wallet_segment and
-- ledger_check.
--
-- Pinned here (invariant I-11 and guard C5): an outsider reads zero rows from
-- each table; a member reads the rows of own characters and own corporations
-- only; anon has no grant; a row names exactly one owner; one segment per
-- (wallet, first entry id); and the rollback file drops all three tables and
-- nothing else.
--
-- Run against a THROWAWAY database from the repo root:
--
--   DATABASE_URL='postgresql://…/throwaway' pnpm run test:sql
--
-- Everything runs inside one transaction and rolls back.
begin;

do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin; exception when duplicate_object then null; end $$;

create schema if not exists auth;
create or replace function auth.uid() returns uuid
language sql stable
as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;

create table public.registration (
  id uuid primary key,
  user_id uuid,
  corporation_id bigint
);
alter table public.registration enable row level security;
create policy "own registrations" on public.registration for select to authenticated
  using (user_id = (select auth.uid()));
grant select on public.registration to anon, authenticated;

create or replace function public.my_corporation_ids()
returns setof bigint
language sql
stable
as $$
  select r.corporation_id
  from public.registration r
  where r.user_id = (select auth.uid()) and r.corporation_id is not null;
$$;
grant execute on function public.my_corporation_ids() to authenticated;

-- A stand-in source table, to prove the rollback leaves it alone.
create table public.corp_wallet_journal (corporation_id bigint, division smallint, entry_id bigint);
insert into public.corp_wallet_journal values (98000001, 1, 1);

\ir ../../supabase/migrations/20261119091512_ledger_check.sql
\ir ../../supabase/migrations/20261120104657_ledger_hidden_credits.sql

-- Account A: character a1 in corporation 98000001. Account B: b1 in 98000002.
insert into public.registration values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000a', 98000001),
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000000b', 98000002);

insert into public.corp_wallet (corporation_id, division, balance) values (98000001, 1, 100), (98000002, 1, 200);
insert into public.ledger_wallet_segment
  (registration_id, corporation_id, division, first_entry_id, last_entry_id, first_date, last_date, opening, closing, row_count)
values
  ('00000000-0000-0000-0000-0000000000a1', null, null, 1, 5, '2026-01-01', '2026-01-02', 0, 50, 5),
  ('00000000-0000-0000-0000-0000000000b1', null, null, 1, 5, '2026-01-01', '2026-01-02', 0, 50, 5),
  (null, 98000001, 1, 10, 20, '2026-01-01', '2026-01-02', 0, 70, 11),
  (null, 98000002, 3, 10, 20, '2026-01-01', '2026-01-02', 0, 70, 11);
insert into public.ledger_check (registration_id, corporation_id, division, ok, segments, new_breaks, rows_read)
values
  ('00000000-0000-0000-0000-0000000000a1', null, null, true, 1, 0, 5),
  (null, 98000001, 1, true, 1, 0, 11),
  (null, 98000002, 3, false, 2, 1, 11);

do $$
declare n bigint;
begin
  select count(*) into n from public.ledger_wallet_segment where wallet_key = '98000001:1';
  assert n = 1, 'wallet_key folds corporation and division';
  select count(*) into n from public.ledger_wallet_segment where wallet_key = '00000000-0000-0000-0000-0000000000a1';
  assert n = 1, 'wallet_key is the registration uuid for a character';
end $$;

-- ── Constraints ────────────────────────────────────────────────────────────
do $$
begin
  begin
    insert into public.ledger_wallet_segment
      (registration_id, corporation_id, division, first_entry_id, last_entry_id, first_date, last_date, opening, closing, row_count)
    values ('00000000-0000-0000-0000-0000000000a1', 98000001, 1, 1, 1, now(), now(), 0, 0, 1);
    raise exception 'a segment with two owners was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.ledger_check (corporation_id, division, ok, segments, new_breaks, rows_read)
    values (98000001, 8, true, 0, 0, 0);
    raise exception 'division 8 was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.ledger_wallet_segment
      (registration_id, first_entry_id, last_entry_id, first_date, last_date, opening, closing, row_count)
    values ('00000000-0000-0000-0000-0000000000a1', 1, 9, now(), now(), 0, 0, 9);
    raise exception 'a second segment at the same first entry id was accepted';
  exception when unique_violation then null;
  end;
  begin
    insert into public.ledger_wallet_segment
      (registration_id, first_entry_id, last_entry_id, first_date, last_date, opening, closing, row_count)
    values ('00000000-0000-0000-0000-0000000000a1', 9, 3, now(), now(), 0, 0, 1);
    raise exception 'a segment that ends before it starts was accepted';
  exception when check_violation then null;
  end;
end $$;

-- ── RLS: an outsider reads nothing ─────────────────────────────────────────
set local role authenticated;
select set_config('test.uid', '00000000-0000-0000-0000-0000000000ff', true);
do $$
declare n bigint;
begin
  select count(*) into n from public.corp_wallet;            assert n = 0, 'outsider: corp_wallet';
  select count(*) into n from public.ledger_wallet_segment;  assert n = 0, 'outsider: segments';
  select count(*) into n from public.ledger_check;           assert n = 0, 'outsider: checks';
end $$;

-- ── RLS: account A reads its character and its corporation only ────────────
select set_config('test.uid', '00000000-0000-0000-0000-00000000000a', true);
do $$
declare n bigint;
begin
  select count(*) into n from public.corp_wallet;
  assert n = 1, format('A: corp_wallet rows %s', n);
  select count(*) into n from public.corp_wallet where corporation_id = 98000002;
  assert n = 0, 'A must not read the other corporation''s balance';
  select count(*) into n from public.ledger_wallet_segment;
  assert n = 2, format('A: segments %s', n);
  select count(*) into n from public.ledger_wallet_segment
    where registration_id = '00000000-0000-0000-0000-0000000000b1' or corporation_id = 98000002;
  assert n = 0, 'A must not read B''s segments';
  select count(*) into n from public.ledger_check;
  assert n = 2, format('A: checks %s', n);
end $$;

-- ── RLS: members cannot write ──────────────────────────────────────────────
do $$
begin
  begin
    insert into public.corp_wallet (corporation_id, division, balance) values (98000001, 1, 1);
    raise exception 'a member wrote corp_wallet';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.ledger_check;
    raise exception 'a member deleted ledger_check';
  exception when insufficient_privilege then null;
  end;
end $$;

-- ── anon has no grant ──────────────────────────────────────────────────────
reset role;
set local role anon;
do $$
begin
  begin
    perform count(*) from public.ledger_wallet_segment;
    raise exception 'anon read ledger_wallet_segment';
  exception when insufficient_privilege then null;
  end;
  begin
    perform count(*) from public.corp_wallet;
    raise exception 'anon read corp_wallet';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- ── The rollback drops the three tables and nothing else ───────────────────
\ir ../../docs/ledger/rollback-stage-1.sql
do $$
declare n bigint;
begin
  assert to_regclass('public.corp_wallet') is null, 'rollback: corp_wallet';
  assert to_regclass('public.ledger_wallet_segment') is null, 'rollback: ledger_wallet_segment';
  assert to_regclass('public.ledger_check') is null, 'rollback: ledger_check';
  select count(*) into n from public.corp_wallet_journal;
  assert n = 1, 'rollback must not touch a source table';
  assert to_regclass('public.registration') is not null, 'rollback must not touch registration';
end $$;

rollback;
