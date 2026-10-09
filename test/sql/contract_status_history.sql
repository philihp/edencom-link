-- SQL-level coverage for migration 20261009051339_contract_status_history.sql:
-- the private contracts' status moving out of character_contract and
-- corp_contract into SCD-2 histories (docs/contract-status.md).
--
-- Pinned here: the backfill dates each existing status from ESI's own date
-- for that state, else the last scan; a status change ends one row and starts
-- the next at the same moment, never earlier than the row it ends; a listing
-- that repeats a status writes nothing; a contract without stored facts gets
-- no status; the views put the current status back beside the facts; owners
-- read only their own; members cannot call the writers; and deleting an
-- account still takes its contracts and their statuses with it.
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

-- Account A: registration ...a1 in corporation 98000001. Account B:
-- registration ...b1 in corporation 98000002.
insert into public.registration (id, user_id, corporation_id) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000a', 98000001),
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000000b', 98000002);

-- Stand-ins in the shape the migration finds them: status still on the row.
create table public.character_contract (
  registration_id uuid not null references public.registration(id) on delete cascade,
  contract_id bigint not null,
  type text not null default 'item_exchange',
  status text not null,
  availability text not null default 'personal',
  for_corporation boolean not null default false,
  issuer_id bigint not null default 90000001,
  issuer_corporation_id bigint not null default 98000001,
  assignee_id bigint,
  acceptor_id bigint,
  start_location_id bigint,
  end_location_id bigint,
  title text,
  price numeric(20, 2),
  reward numeric(20, 2),
  collateral numeric(20, 2),
  buyout numeric(20, 2),
  volume double precision,
  days_to_complete integer,
  date_issued timestamptz not null,
  date_expired timestamptz not null default '2026-12-31T00:00:00Z',
  date_accepted timestamptz,
  date_completed timestamptz,
  items_fetched_at timestamptz,
  seen_at timestamptz not null default now(),
  primary key (registration_id, contract_id)
);
alter table public.character_contract enable row level security;
create policy "Users read own contracts" on public.character_contract for select to authenticated
  using (registration_id in (select id from public.registration where user_id = (select auth.uid())));
grant select on public.character_contract to authenticated;
grant all on public.character_contract to service_role;

create table public.corp_contract (
  corporation_id bigint not null,
  contract_id bigint not null,
  registration_id uuid not null references public.registration(id) on delete cascade,
  type text not null default 'item_exchange',
  status text not null,
  availability text not null default 'corporation',
  for_corporation boolean not null default true,
  issuer_id bigint not null default 90000001,
  issuer_corporation_id bigint not null default 98000001,
  assignee_id bigint,
  acceptor_id bigint,
  start_location_id bigint,
  end_location_id bigint,
  title text,
  price numeric(20, 2),
  reward numeric(20, 2),
  collateral numeric(20, 2),
  buyout numeric(20, 2),
  volume double precision,
  days_to_complete integer,
  date_issued timestamptz not null,
  date_expired timestamptz not null default '2026-12-31T00:00:00Z',
  date_accepted timestamptz,
  date_completed timestamptz,
  items_fetched_at timestamptz,
  seen_at timestamptz not null default now(),
  primary key (corporation_id, contract_id)
);
alter table public.corp_contract enable row level security;
create policy "Users read own corp contracts" on public.corp_contract for select to authenticated
  using (corporation_id in (select corporation_id from public.registration
                            where user_id = (select auth.uid()) and corporation_id is not null));
grant select on public.corp_contract to authenticated;
grant all on public.corp_contract to service_role;

insert into public.character_contract (registration_id, contract_id, status, date_issued, date_accepted, date_completed, acceptor_id, seen_at) values
  ('00000000-0000-0000-0000-0000000000a1', 1, 'outstanding', '2026-10-01T00:00:00Z', null, null, null, '2026-10-08T00:00:00Z'),
  ('00000000-0000-0000-0000-0000000000a1', 2, 'in_progress', '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z', null, 90000002, '2026-10-08T00:00:00Z'),
  ('00000000-0000-0000-0000-0000000000a1', 3, 'finished', '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z', '2026-10-03T00:00:00Z', 90000002, '2026-10-08T00:00:00Z'),
  ('00000000-0000-0000-0000-0000000000a1', 4, 'deleted', '2026-10-01T00:00:00Z', null, null, null, '2026-10-07T00:00:00Z'),
  ('00000000-0000-0000-0000-0000000000b1', 20, 'outstanding', '2026-10-04T00:00:00Z', null, null, null, '2026-10-08T00:00:00Z');

insert into public.corp_contract (corporation_id, contract_id, registration_id, status, date_issued, date_completed, seen_at) values
  (98000001, 10, '00000000-0000-0000-0000-0000000000a1', 'finished_contractor', '2026-10-01T00:00:00Z', null, '2026-10-06T00:00:00Z'),
  (98000002, 30, '00000000-0000-0000-0000-0000000000b1', 'outstanding', '2026-10-05T00:00:00Z', null, '2026-10-08T00:00:00Z');

\i supabase/migrations/20261009051339_contract_status_history.sql

-- The backfill: one current row per contract, dated by ESI where it can be.
do $$
declare
  got timestamptz;
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name in ('character_contract', 'corp_contract') and column_name = 'status') then
    raise exception 'the status column should be gone from the contract tables';
  end if;
  if (select count(*) from public.character_contract_status_over_time) <> 5
     or (select count(*) from public.corp_contract_status_over_time) <> 2 then
    raise exception 'expected one backfilled row per contract';
  end if;

  select valid_from into got from public.character_contract_status where contract_id = 1;
  if got <> '2026-10-01T00:00:00Z' then raise exception 'outstanding should begin at date_issued, got %', got; end if;
  select valid_from into got from public.character_contract_status where contract_id = 2;
  if got <> '2026-10-02T00:00:00Z' then raise exception 'in_progress should begin at date_accepted, got %', got; end if;
  select valid_from into got from public.character_contract_status where contract_id = 3;
  if got <> '2026-10-03T00:00:00Z' then raise exception 'finished should begin at date_completed, got %', got; end if;
  select valid_from into got from public.character_contract_status where contract_id = 4;
  if got <> '2026-10-07T00:00:00Z' then raise exception 'deleted has no ESI date and should begin at seen_at, got %', got; end if;
  select valid_from into got from public.corp_contract_status where contract_id = 10;
  if got <> '2026-10-06T00:00:00Z' then raise exception 'a finished contract with no completion date falls back to seen_at, got %', got; end if;

  -- The facts-plus-status views read like the old tables.
  if (select status from public.character_contract_with_status where contract_id = 2) <> 'in_progress'
     or (select acceptor_id from public.character_contract_with_status where contract_id = 2) <> 90000002
     or (select status from public.corp_contract_with_status where contract_id = 10) <> 'finished_contractor' then
    raise exception 'the with_status views should carry the current status beside the facts';
  end if;
end $$;

-- A scan: 1 is unchanged, 2 has finished, 3 is unchanged, 4 is no longer
-- listed (aged out of ESI's window), 99 has no stored facts.
do $$
declare
  answer jsonb;
  s record;
begin
  update public.character_contract set date_completed = '2026-10-05T00:00:00Z'
   where registration_id = '00000000-0000-0000-0000-0000000000a1' and contract_id = 2;

  answer := public.character_contract_status_sync('00000000-0000-0000-0000-0000000000a1', '[
    {"contract_id": 1, "status": "outstanding", "since": "2026-10-01T00:00:00Z"},
    {"contract_id": 2, "status": "finished", "since": "2026-10-05T00:00:00Z"},
    {"contract_id": 3, "status": "finished", "since": "2026-10-03T00:00:00Z"},
    {"contract_id": 99, "status": "outstanding", "since": "2026-10-05T00:00:00Z"}
  ]'::jsonb);
  if (answer ->> 'changed')::int <> 1 or (answer ->> 'opened')::int <> 1 then
    -- opened counts contract 2's new row; 99 has no facts and gets nothing.
    raise exception 'expected one change and one new row: %', answer;
  end if;

  select * into s from public.character_contract_status_over_time
   where contract_id = 2 and status = 'in_progress';
  if s.is_current or s.valid_until <> '2026-10-05T00:00:00Z' then
    raise exception 'in_progress should end when it finished: %', row_to_json(s);
  end if;
  select * into s from public.character_contract_status where contract_id = 2;
  if s.status <> 'finished' or s.valid_from <> '2026-10-05T00:00:00Z' then
    raise exception 'finished should begin where in_progress ended: %', row_to_json(s);
  end if;

  if (select count(*) from public.character_contract_status_over_time where contract_id in (1, 3)) <> 2 then
    raise exception 'an unchanged status must not gain a row';
  end if;
  if (select status from public.character_contract_status where contract_id = 4) <> 'deleted' then
    raise exception 'a contract that left the listing keeps its last status';
  end if;
  if exists (select 1 from public.character_contract_status_over_time where contract_id = 99) then
    raise exception 'a contract with no stored facts must not get a status';
  end if;

  -- The same scan again writes nothing.
  answer := public.character_contract_status_sync('00000000-0000-0000-0000-0000000000a1', '[
    {"contract_id": 1, "status": "outstanding", "since": "2026-10-01T00:00:00Z"},
    {"contract_id": 2, "status": "finished", "since": "2026-10-05T00:00:00Z"}
  ]'::jsonb);
  if (answer ->> 'changed')::int <> 0 or (answer ->> 'opened')::int <> 0 then
    raise exception 'a repeated scan must write nothing: %', answer;
  end if;

  -- A change dated before the row it ends (an undated state stamped by a scan
  -- whose clock ran behind) is held at that row's start, so history never
  -- runs backwards.
  answer := public.character_contract_status_sync('00000000-0000-0000-0000-0000000000a1', '[
    {"contract_id": 3, "status": "reversed", "since": "2026-09-01T00:00:00Z"}
  ]'::jsonb);
  select * into s from public.character_contract_status where contract_id = 3;
  if s.status <> 'reversed' or s.valid_from <> '2026-10-03T00:00:00Z' then
    raise exception 'a late-dated change should start where the ended row began: %', row_to_json(s);
  end if;
end $$;

-- A new contract: facts first, then its first status.
insert into public.character_contract (registration_id, contract_id, date_issued)
values ('00000000-0000-0000-0000-0000000000a1', 5, '2026-10-06T00:00:00Z');

do $$
declare
  answer jsonb;
begin
  answer := public.character_contract_status_sync('00000000-0000-0000-0000-0000000000a1', '[
    {"contract_id": 5, "status": "outstanding", "since": "2026-10-06T00:00:00Z"}
  ]'::jsonb);
  if (answer ->> 'opened')::int <> 1
     or (select valid_from from public.character_contract_status where contract_id = 5) <> '2026-10-06T00:00:00Z' then
    raise exception 'a new contract should open at its since: %', answer;
  end if;
  -- And it shows in the view, with no status column on the row it came from.
  if (select status from public.character_contract_with_status where contract_id = 5) <> 'outstanding' then
    raise exception 'the new contract should read as outstanding';
  end if;

  -- The corporation twin.
  answer := public.corp_contract_status_sync(98000001, '[
    {"contract_id": 10, "status": "finished_contractor", "since": "2026-10-06T00:00:00Z"}
  ]'::jsonb);
  if (answer ->> 'changed')::int <> 0 or (answer ->> 'opened')::int <> 0 then
    raise exception 'the corp twin should write nothing for an unchanged status: %', answer;
  end if;
  answer := public.corp_contract_status_sync(98000002, '[
    {"contract_id": 30, "status": "in_progress", "since": "2026-10-07T00:00:00Z"}
  ]'::jsonb);
  if (answer ->> 'changed')::int <> 1
     or (select status from public.corp_contract_status where contract_id = 30) <> 'in_progress' then
    raise exception 'the corp twin should record a change: %', answer;
  end if;
  -- A corporation's sync never touches another corporation's contract.
  answer := public.corp_contract_status_sync(98000001, '[
    {"contract_id": 30, "status": "finished", "since": "2026-10-08T00:00:00Z"}
  ]'::jsonb);
  if (select status from public.corp_contract_status where contract_id = 30) <> 'in_progress' then
    raise exception 'corporation 98000001 changed corporation 98000002''s contract';
  end if;
end $$;

-- Owners read only their own; members call none of the writers.
set local role authenticated;
select set_config('test.uid', '00000000-0000-0000-0000-00000000000a', true);
do $$
begin
  if (select count(*) from public.character_contract_status) <> 5 then
    raise exception 'account A should see its five contracts'' statuses';
  end if;
  if exists (select 1 from public.character_contract_status_over_time
             where registration_id = '00000000-0000-0000-0000-0000000000b1') then
    raise exception 'account A read account B''s statuses';
  end if;
  if (select count(*) from public.corp_contract_with_status) <> 1 then
    raise exception 'account A should see only its own corporation''s contract';
  end if;
  begin
    perform public.character_contract_status_sync('00000000-0000-0000-0000-0000000000a1', '[]'::jsonb);
    raise exception 'a member was allowed to write statuses';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.corp_contract_status_sync(98000001, '[]'::jsonb);
    raise exception 'a member was allowed to write corp statuses';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- Deleting an account still takes its contracts, and their statuses, along.
delete from public.registration where id = '00000000-0000-0000-0000-0000000000b1';
do $$
begin
  if exists (select 1 from public.character_contract_status_over_time where registration_id = '00000000-0000-0000-0000-0000000000b1')
     or exists (select 1 from public.corp_contract_status_over_time where corporation_id = 98000002) then
    raise exception 'statuses outlived their account';
  end if;
end $$;

rollback;
