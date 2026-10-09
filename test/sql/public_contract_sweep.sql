-- SQL-level coverage for public_contract_sweep(): one region's reconcile
-- against a complete listing of its public contracts (docs/public-contracts.md).
-- The rules pinned here are the ones a wrong answer would corrupt silently:
-- a contract missing from the listing is closed, with the right closure; one
-- listed again is reopened; only never-stored ids come back as new; another
-- region is never touched; and the function cannot be called by a member.
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

-- Region 10000002: contract 1 expires long after the sweep, contract 2 expired
-- before it, contract 3 stays listed. Region 10000043: contract 10, never
-- listed in any sweep of 10000002.
insert into public.public_contract
  (contract_id, region_id, type, issuer_id, issuer_corporation_id, date_issued, date_expired, first_seen_at)
values
  (1, 10000002, 'item_exchange', 90000001, 98000001, '2026-10-01T00:00:00Z', '2026-10-30T00:00:00Z', '2026-10-01T00:30:00Z'),
  (2, 10000002, 'courier',       90000002, 98000002, '2026-09-25T00:00:00Z', '2026-10-09T03:50:00Z', '2026-09-25T00:30:00Z'),
  (3, 10000002, 'auction',       90000003, 98000003, '2026-10-05T00:00:00Z', '2026-10-30T00:00:00Z', '2026-10-05T00:30:00Z'),
  (10, 10000043, 'item_exchange', 90000004, 98000004, '2026-10-05T00:00:00Z', '2026-10-30T00:00:00Z', '2026-10-05T00:30:00Z');

do $$
declare
  answer jsonb;
  c record;
begin
  -- Snapshot at 04:09: 1 and 2 are gone, 3 is still listed, 4 is new.
  answer := public.public_contract_sweep(10000002, array[3, 4]::bigint[], '2026-10-09T04:09:24Z', '2026-10-09T03:39:24Z');

  if (answer ->> 'closed')::int <> 2 or (answer ->> 'reopened')::int <> 0 then
    raise exception 'expected 2 closed, 0 reopened: %', answer;
  end if;
  if answer -> 'new_ids' <> '[4]'::jsonb then
    raise exception 'expected only contract 4 to be new: %', answer;
  end if;

  select * into c from public.public_contract where contract_id = 1;
  if c.closed_at <> '2026-10-09T04:09:24Z' or c.closure <> 'gone' or c.last_seen_at <> '2026-10-09T03:39:24Z' then
    raise exception 'contract 1 should be gone, last seen at the previous snapshot: %', row_to_json(c);
  end if;

  -- Expired before the snapshot that missed it: expired, not taken.
  select * into c from public.public_contract where contract_id = 2;
  if c.closure <> 'expired' then
    raise exception 'contract 2 should read as expired: %', row_to_json(c);
  end if;

  -- Still listed: untouched.
  select * into c from public.public_contract where contract_id = 3;
  if c.closed_at is not null or c.last_seen_at is not null then
    raise exception 'contract 3 is still listed and must not change: %', row_to_json(c);
  end if;

  -- Another region is never closed by this one's listing.
  select * into c from public.public_contract where contract_id = 10;
  if c.closed_at is not null then
    raise exception 'contract 10 is in another region and must stay open: %', row_to_json(c);
  end if;
end $$;

-- The caller inserts what came back as new.
insert into public.public_contract
  (contract_id, region_id, type, issuer_id, issuer_corporation_id, date_issued, date_expired, first_seen_at)
values
  (4, 10000002, 'item_exchange', 90000005, 98000005, '2026-10-09T04:00:00Z', '2026-10-30T00:00:00Z', '2026-10-09T04:09:24Z');

do $$
declare
  answer jsonb;
  c record;
begin
  -- Contract 1 is listed again (the earlier listing was wrong about it), and
  -- the listing repeats an id: 1 reopens, nothing is new, nothing new closes.
  answer := public.public_contract_sweep(10000002, array[3, 4, 1, 4]::bigint[], '2026-10-09T04:39:24Z', '2026-10-09T04:09:24Z');

  if (answer ->> 'closed')::int <> 0 or (answer ->> 'reopened')::int <> 1 or answer -> 'new_ids' <> '[]'::jsonb then
    raise exception 'expected one reopen and nothing else: %', answer;
  end if;

  select * into c from public.public_contract where contract_id = 1;
  if c.closed_at is not null or c.closure is not null or c.last_seen_at is not null then
    raise exception 'contract 1 should be open again: %', row_to_json(c);
  end if;

  -- A closed contract that stays unlisted keeps its first closure.
  select * into c from public.public_contract where contract_id = 2;
  if c.closed_at <> '2026-10-09T04:09:24Z' then
    raise exception 'contract 2 should keep its first closed_at: %', row_to_json(c);
  end if;

  -- The first sweep of a region has no previous snapshot: a contract closing
  -- then was last seen when it was first seen.
  answer := public.public_contract_sweep(10000043, array[]::bigint[], '2026-10-09T04:39:24Z', null);
  select * into c from public.public_contract where contract_id = 10;
  if c.closure <> 'gone' or c.last_seen_at <> c.first_seen_at then
    raise exception 'contract 10 should be gone, last seen when first seen: %', row_to_json(c);
  end if;
end $$;

-- A closed row must carry a closure, and an open one must not.
do $$
begin
  begin
    update public.public_contract set closure = 'gone' where contract_id = 3;
    raise exception 'an open contract accepted a closure';
  exception when check_violation then null;
  end;
end $$;

-- Items go with their contract.
insert into public.public_contract_item (contract_id, record_id, type_id, quantity, is_included) values (4, 1, 34, 1000, true);
delete from public.public_contract where contract_id = 4;
do $$
begin
  if exists (select 1 from public.public_contract_item where contract_id = 4) then
    raise exception 'items outlived their contract';
  end if;
end $$;

-- Members read; members cannot sweep.
set local role authenticated;
do $$
begin
  if (select count(*) from public.public_contract) <> 4 then
    raise exception 'a member should read every public contract';
  end if;
  begin
    perform public.public_contract_sweep(10000002, array[]::bigint[], now(), null);
    raise exception 'a member was allowed to sweep';
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
end $$;
reset role;

rollback;
