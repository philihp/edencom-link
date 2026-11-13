-- SQL-level coverage for trade_contract_party_ids() — the one statement the
-- universe-names job asks for every counterparty of a finished trade contract
-- (supabase/migrations/20261117013400_disk_io_hot_queries.sql), replacing a
-- 1,000-row OFFSET page per contract that was one of the database's two
-- largest Disk IO consumers.
--
-- Pinned here: only finished item exchanges and auctions count, only those
-- accepted inside the window, from both the character and the corp view; the
-- issuer, the issuer's corporation and the acceptor are all parties; an id on
-- several contracts comes back once; a missing acceptor (null) or a zero id is
-- never a party; an empty window answers an empty array rather than null; and
-- members cannot call it. The migration also replaces
-- refresh_asset_location_summary_cache(), whose walk
-- test/sql/asset_location_summary_cache.sql covers; this only checks that the
-- replacement keeps the plan_cache_mode setting the rewrite depends on.
--
-- Run against a THROWAWAY database (it creates stand-ins named after the real
-- views in `public`) from the repo root, so the \i below resolves:
--
--   DATABASE_URL='postgresql://…/throwaway' pnpm run test:sql
--
-- Everything runs inside one transaction and rolls back.
begin;

do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin; exception when duplicate_object then null; end $$;

-- The two views the function reads, as tables carrying the columns it touches.
create table public.character_contract_with_status (
  registration_id uuid not null,
  contract_id bigint not null,
  type text not null,
  status text,
  date_accepted timestamptz,
  issuer_id bigint not null,
  issuer_corporation_id bigint not null,
  acceptor_id bigint
);
create table public.corp_contract_with_status (
  corporation_id bigint not null,
  contract_id bigint not null,
  type text not null,
  status text,
  date_accepted timestamptz,
  issuer_id bigint not null,
  issuer_corporation_id bigint not null,
  acceptor_id bigint
);

\i supabase/migrations/20261117013400_disk_io_hot_queries.sql

insert into public.character_contract_with_status values
  ('11111111-1111-1111-1111-111111111111', 1, 'item_exchange', 'finished',    now() - interval '1 day',    90000001, 98000001, 90000002),
  -- A courier is never a trade.
  ('11111111-1111-1111-1111-111111111111', 2, 'courier',       'finished',    now() - interval '1 day',    90000003, 98000001, 90000004),
  -- Accepted before the window.
  ('11111111-1111-1111-1111-111111111111', 3, 'auction',       'finished',    now() - interval '400 days', 90000005, 98000001, 90000006),
  -- Not finished.
  ('11111111-1111-1111-1111-111111111111', 4, 'item_exchange', 'outstanding', now() - interval '1 day',    90000007, 98000001, null);

insert into public.corp_contract_with_status values
  -- 90000001 again, from the other view; no acceptor.
  (98000001, 5, 'auction',       'finished', now() - interval '2 days', 90000001, 98000002, null),
  -- A zero acceptor is no party.
  (98000001, 6, 'item_exchange', 'finished', now() - interval '3 days', 90000008, 98000002, 0);

do $$
declare
  got bigint[] := public.trade_contract_party_ids(now() - interval '180 days');
begin
  if (select array_agg(x order by x) from unnest(got) x)
     is distinct from array[90000001, 90000002, 90000008, 98000001, 98000002]::bigint[] then
    raise exception 'expected the five parties of the three finished trades in the window, got %', got;
  end if;
  if cardinality(got) <> 5 then
    raise exception 'a party on several contracts must come back once, got %', got;
  end if;
end $$;

do $$
begin
  if public.trade_contract_party_ids(now()) is distinct from '{}'::bigint[] then
    raise exception 'an empty window must answer an empty array, got %', public.trade_contract_party_ids(now());
  end if;
end $$;

do $$
begin
  if has_function_privilege('anon', 'public.trade_contract_party_ids(timestamptz)', 'execute')
     or has_function_privilege('authenticated', 'public.trade_contract_party_ids(timestamptz)', 'execute') then
    raise exception 'members must not be able to call trade_contract_party_ids()';
  end if;
  if not has_function_privilege('service_role', 'public.trade_contract_party_ids(timestamptz)', 'execute') then
    raise exception 'the service role must be able to call trade_contract_party_ids()';
  end if;
end $$;

-- Without it plpgsql switches to a generic plan after five calls, and a generic
-- plan cannot see how short the owner arrays are: it joins every current item
-- again instead of probing the few the account has.
do $$
begin
  if not exists (
    select 1 from pg_proc
    where oid = 'public.refresh_asset_location_summary_cache(uuid)'::regprocedure
      and 'plan_cache_mode=force_custom_plan' = any(proconfig)
  ) then
    raise exception 'refresh_asset_location_summary_cache() lost its plan_cache_mode setting';
  end if;
end $$;

rollback;
