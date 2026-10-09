-- SQL-level coverage for the public-contracts tables (docs/public-contracts.md):
-- the frozen facts in public_contract, the SCD-2 status history in
-- public_contract_status_over_time, and the three functions the extract calls.
-- The rules pinned here are the ones a wrong answer would corrupt silently: a
-- contract missing from a listing gets a closed status with the right kind;
-- one listed again is reopened; each change keeps the old row with the window
-- the change happened in; only contracts with no status come back as new;
-- another region is never touched; and nothing can be deleted, not even by
-- the service role the extract writes with.
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

\i supabase/migrations/20261009035853_public_contracts.sql

-- Region 10000002: contract 1 expires long after every sweep here, contract 2
-- expired before the first one, contract 3 stays listed. Region 10000043:
-- contract 10, never listed in a sweep of 10000002.
insert into public.public_contract
  (contract_id, region_id, type, issuer_id, issuer_corporation_id, date_issued, date_expired, first_seen_at)
values
  (1, 10000002, 'item_exchange', 90000001, 98000001, '2026-10-01T00:00:00Z', '2026-10-30T00:00:00Z', '2026-10-09T03:09:24Z'),
  (2, 10000002, 'courier',       90000002, 98000002, '2026-09-25T00:00:00Z', '2026-10-09T03:50:00Z', '2026-10-09T03:09:24Z'),
  (3, 10000002, 'auction',       90000003, 98000003, '2026-10-05T00:00:00Z', '2026-10-30T00:00:00Z', '2026-10-09T03:09:24Z'),
  (10, 10000043, 'item_exchange', 90000004, 98000004, '2026-10-05T00:00:00Z', '2026-10-30T00:00:00Z', '2026-10-09T03:09:24Z');

do $$
begin
  if public.public_contract_open(10000002, array[1, 2, 3]::bigint[], '2026-10-09T03:09:24Z') <> 3 then
    raise exception 'three contracts should open';
  end if;
  if public.public_contract_open(10000043, array[10]::bigint[], '2026-10-09T03:09:24Z') <> 1 then
    raise exception 'contract 10 should open';
  end if;
  -- Opening again is a no-op, and an id with no stored facts opens nothing.
  if public.public_contract_open(10000002, array[1, 2, 3, 99]::bigint[], '2026-10-09T03:39:24Z') <> 0 then
    raise exception 'opening twice must not add statuses';
  end if;
end $$;

do $$
declare
  answer jsonb;
  s record;
begin
  -- Snapshot at 04:09: 1 and 2 are gone, 3 is still listed, 4 is new. The
  -- snapshot before it, at 03:39, was the last to list 1 and 2.
  answer := public.public_contract_sweep(10000002, array[3, 4]::bigint[], '2026-10-09T04:09:24Z', '2026-10-09T03:39:24Z');

  if (answer ->> 'closed')::int <> 2 or (answer ->> 'reopened')::int <> 0 then
    raise exception 'expected 2 closed, 0 reopened: %', answer;
  end if;
  if answer -> 'new_ids' <> '[4]'::jsonb then
    raise exception 'expected only contract 4 to be new: %', answer;
  end if;

  -- Contract 1 keeps its outstanding row, closed at the last snapshot that
  -- listed it, and gains a 'gone' row from the first snapshot without it.
  select * into s from public.public_contract_status_over_time where contract_id = 1 and status = 'outstanding';
  if s.is_current or s.valid_until <> '2026-10-09T03:39:24Z' then
    raise exception 'contract 1''s outstanding row should end at the last listing: %', row_to_json(s);
  end if;
  select * into s from public.public_contract_status where contract_id = 1;
  if s.status <> 'gone' or s.valid_from <> '2026-10-09T04:09:24Z' then
    raise exception 'contract 1 should be gone from 04:09: %', row_to_json(s);
  end if;

  -- Expired before the snapshot that missed it: expired, not taken.
  select * into s from public.public_contract_status where contract_id = 2;
  if s.status <> 'expired' then
    raise exception 'contract 2 should read as expired: %', row_to_json(s);
  end if;

  -- Still listed: one row, untouched.
  if (select count(*) from public.public_contract_status_over_time where contract_id = 3) <> 1 then
    raise exception 'contract 3 is still listed and must keep a single row';
  end if;

  -- Another region is never closed by this one's listing.
  select * into s from public.public_contract_status where contract_id = 10;
  if s.status <> 'outstanding' then
    raise exception 'contract 10 is in another region and must stay outstanding: %', row_to_json(s);
  end if;
end $$;

-- The caller stores contract 4's facts, then opens it.
insert into public.public_contract
  (contract_id, region_id, type, issuer_id, issuer_corporation_id, date_issued, date_expired, first_seen_at)
values
  (4, 10000002, 'item_exchange', 90000005, 98000005, '2026-10-09T04:00:00Z', '2026-10-30T00:00:00Z', '2026-10-09T04:09:24Z');
select public.public_contract_open(10000002, array[4]::bigint[], '2026-10-09T04:09:24Z');

do $$
declare
  answer jsonb;
  s record;
begin
  -- Contract 1 is listed again (the earlier listing was wrong about it), and
  -- the listing repeats an id: 1 reopens, nothing is new, nothing new closes.
  answer := public.public_contract_sweep(10000002, array[3, 4, 1, 4]::bigint[], '2026-10-09T04:39:24Z', '2026-10-09T04:09:24Z');

  if (answer ->> 'closed')::int <> 0 or (answer ->> 'reopened')::int <> 1 or answer -> 'new_ids' <> '[]'::jsonb then
    raise exception 'expected one reopen and nothing else: %', answer;
  end if;

  -- Three rows now: outstanding, gone, outstanding.
  if (select array_agg(status order by valid_from) from public.public_contract_status_over_time where contract_id = 1)
       <> array['outstanding', 'gone', 'outstanding'] then
    raise exception 'contract 1''s history is wrong';
  end if;
  select * into s from public.public_contract_status where contract_id = 1;
  if s.status <> 'outstanding' or s.valid_from <> '2026-10-09T04:39:24Z' then
    raise exception 'contract 1 should be outstanding again from 04:39: %', row_to_json(s);
  end if;
  select * into s from public.public_contract_status_over_time where contract_id = 1 and status = 'gone';
  if s.is_current or s.valid_until <> '2026-10-09T04:09:24Z' then
    raise exception 'contract 1''s gone row should end at the last snapshot without it: %', row_to_json(s);
  end if;

  -- A closed contract that stays unlisted keeps its one closed row.
  if (select count(*) from public.public_contract_status_over_time where contract_id = 2) <> 2 then
    raise exception 'contract 2 should have exactly two rows';
  end if;
end $$;

-- A run that died after storing facts but before opening them: the contract
-- has no status, so the next sweep answers it as new again.
insert into public.public_contract
  (contract_id, region_id, type, issuer_id, issuer_corporation_id, date_issued, date_expired, first_seen_at)
values
  (5, 10000002, 'courier', 90000006, 98000006, '2026-10-09T04:30:00Z', '2026-10-30T00:00:00Z', '2026-10-09T04:39:24Z');

do $$
declare
  answer jsonb;
begin
  answer := public.public_contract_sweep(10000002, array[1, 3, 4, 5]::bigint[], '2026-10-09T05:09:24Z', '2026-10-09T04:39:24Z');
  if answer -> 'new_ids' <> '[5]'::jsonb then
    raise exception 'a stored contract with no status should come back as new: %', answer;
  end if;
  if public.public_contract_open(10000002, array[5]::bigint[], '2026-10-09T05:09:24Z') <> 1 then
    raise exception 'contract 5 should open';
  end if;

  -- The first sweep of a region has no previous snapshot: the closed row's
  -- predecessor ends where it began.
  answer := public.public_contract_sweep(10000043, array[]::bigint[], '2026-10-09T05:09:24Z', null);
  if (select status from public.public_contract_status where contract_id = 10) <> 'gone'
     or (select valid_until = valid_from from public.public_contract_status_over_time
          where contract_id = 10 and status = 'outstanding') is not true then
    raise exception 'contract 10 should be gone, its outstanding row ending where it began';
  end if;
end $$;

-- The item backlog: outstanding item exchanges and auctions only, newest
-- first. Contract 2 is a closed courier, 5 an open courier, 10 is closed.
update public.public_contract set items_fetched_at = now(), items_status = 200 where contract_id = 3;
do $$
begin
  if array(select public.public_contract_items_owed(10)) <> array[4, 1]::bigint[] then
    raise exception 'expected the backlog 4, 1: %', array(select public.public_contract_items_owed(10));
  end if;
  if array(select public.public_contract_items_owed(1)) <> array[4]::bigint[] then
    raise exception 'the backlog limit was not honoured';
  end if;
end $$;

-- One current status per contract.
do $$
begin
  begin
    insert into public.public_contract_status_over_time (contract_id, region_id, status, valid_from, valid_until)
    values (3, 10000002, 'gone', now(), now());
    raise exception 'a second current status was accepted';
  exception when unique_violation then null;
  end;
end $$;

-- Items belong to a contract that exists.
do $$
begin
  begin
    insert into public.public_contract_item (contract_id, record_id, type_id, quantity, is_included) values (999, 1, 34, 1, true);
    raise exception 'an item without a contract was accepted';
  exception when foreign_key_violation then null;
  end;
end $$;
insert into public.public_contract_item (contract_id, record_id, type_id, quantity, is_included) values (4, 1, 34, 1000, true);

-- Nothing is ever deleted, not even by the role the extract writes with.
set local role service_role;
do $$
begin
  begin
    delete from public.public_contract where contract_id = 2;
    raise exception 'the service role deleted a contract';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.public_contract_status_over_time where contract_id = 2;
    raise exception 'the service role deleted a status';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.public_contract_item where contract_id = 4;
    raise exception 'the service role deleted an item';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- Members read everything; members call none of the extract's functions.
set local role authenticated;
do $$
begin
  if (select count(*) from public.public_contract) <> 6 then
    raise exception 'a member should read every public contract';
  end if;
  if (select count(*) from public.public_contract_status) <> 6 then
    raise exception 'a member should read every current status';
  end if;
  begin
    perform public.public_contract_sweep(10000002, array[]::bigint[], now(), null);
    raise exception 'a member was allowed to sweep';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.public_contract_open(10000002, array[]::bigint[], now());
    raise exception 'a member was allowed to open statuses';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.public_contract_items_owed(1);
    raise exception 'a member was allowed to read the item backlog function';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- Anonymous visitors read nothing.
set local role anon;
do $$
begin
  begin
    perform 1 from public.public_contract limit 1;
    raise exception 'anon was allowed to read public contracts';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.public_contract_status limit 1;
    raise exception 'anon was allowed to read public contract statuses';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

rollback;
