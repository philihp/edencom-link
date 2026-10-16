-- SQL-level coverage for public_contract_search(), the MCP
-- search_public_contracts query (docs/public-contracts.md). Pinned: an item
-- filter matches only what a contract OFFERS, never what it asks for; the
-- status filter defaults to outstanding; a system filter finds a contract by
-- its NPC station, by a player structure we know, and by the archive's
-- resolved system_id; an issuer id matches the character or the corporation;
-- a price bound drops a contract with no price; the total covers every match
-- while row_limit caps the rows; and item_limit caps the lines per contract.
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
\i supabase/migrations/20261011194400_public_contract_archive.sql

-- Stand-ins for the two location sources the function resolves through.
create table public.sde_station (station_id bigint primary key, name text, system_id bigint);
create table public.universe_structure (structure_id bigint primary key, name text, system_id bigint);
insert into public.sde_station values (60003760, 'Jita IV - Moon 4 - Caldari Navy Assembly Plant', 30000142);
insert into public.universe_structure values (1035466617946, 'Perimeter - Tranquility Trading Tower', 30000144);

\i supabase/migrations/20261016175142_public_contract_search.sql

-- 1: outstanding item exchange at a Jita station, offers 2 Tritanium-ish lines.
-- 2: outstanding item exchange in a Perimeter structure, ASKS for type 34.
-- 3: closed ('gone') auction in Jita, offers type 34.
-- 4: outstanding courier from Jita, no price.
-- 5: outstanding item exchange whose only place is the archive's system_id.
insert into public.public_contract
  (contract_id, region_id, type, issuer_id, issuer_corporation_id, start_location_id, end_location_id,
   price, reward, date_issued, date_expired, first_seen_at, system_id)
values
  (1, 10000002, 'item_exchange', 90000001, 98000001, 60003760, 60003760, 1000000, null,
   '2026-10-10T00:00:00Z', '2026-11-10T00:00:00Z', '2026-10-10T00:00:00Z', null),
  (2, 10000002, 'item_exchange', 90000002, 98000002, 1035466617946, 1035466617946, 5000000, null,
   '2026-10-11T00:00:00Z', '2026-11-11T00:00:00Z', '2026-10-11T00:00:00Z', null),
  (3, 10000002, 'auction', 90000003, 98000001, 60003760, 60003760, 200000, null,
   '2026-10-12T00:00:00Z', '2026-11-12T00:00:00Z', '2026-10-12T00:00:00Z', null),
  (4, 10000002, 'courier', 90000004, 98000004, 60003760, 1035466617946, null, 3000000,
   '2026-10-13T00:00:00Z', '2026-11-13T00:00:00Z', '2026-10-13T00:00:00Z', null),
  (5, 10000043, 'item_exchange', 90000005, 98000005, 99999999, 99999999, 300000, null,
   '2026-10-14T00:00:00Z', '2026-11-14T00:00:00Z', '2026-10-14T00:00:00Z', 30002187);

insert into public.public_contract_status_over_time (contract_id, region_id, status, valid_from, valid_until, is_current)
values
  (1, 10000002, 'outstanding', '2026-10-10T00:00:00Z', '2026-10-10T00:00:00Z', true),
  (2, 10000002, 'outstanding', '2026-10-11T00:00:00Z', '2026-10-11T00:00:00Z', true),
  (3, 10000002, 'outstanding', '2026-10-12T00:00:00Z', '2026-10-13T00:00:00Z', false),
  (3, 10000002, 'gone',        '2026-10-13T00:30:00Z', '2026-10-13T00:30:00Z', true),
  (4, 10000002, 'outstanding', '2026-10-13T00:00:00Z', '2026-10-13T00:00:00Z', true),
  (5, 10000043, 'outstanding', '2026-10-14T00:00:00Z', '2026-10-14T00:00:00Z', true);

insert into public.public_contract_item (contract_id, record_id, type_id, quantity, is_included)
values
  (1, 1, 34, 1000, true),
  (1, 2, 35, 500, true),
  (2, 1, 34, 1000, false),
  (2, 2, 36, 10, true),
  (3, 1, 34, 50, true);

do $$
declare
  r json;
  ids bigint[];
begin
  -- Default: outstanding only, newest first.
  r := public.public_contract_search();
  select array_agg((c ->> 'contract_id')::bigint) into ids from json_array_elements(r -> 'contracts') c;
  if ids <> array[5, 4, 2, 1]::bigint[] or (r ->> 'total')::int <> 4 then
    raise exception 'default search should list 5, 4, 2, 1: %', r;
  end if;

  -- An item matches what is offered, not what is asked for; closed auction 3
  -- appears only once closed contracts are asked for.
  r := public.public_contract_search(type_ids => array[34]::bigint[]);
  select array_agg((c ->> 'contract_id')::bigint) into ids from json_array_elements(r -> 'contracts') c;
  if ids <> array[1]::bigint[] then
    raise exception 'type 34 offered and outstanding is only contract 1: %', r;
  end if;
  r := public.public_contract_search(type_ids => array[34]::bigint[], status_filter => 'any');
  select array_agg((c ->> 'contract_id')::bigint) into ids from json_array_elements(r -> 'contracts') c;
  if ids <> array[3, 1]::bigint[] then
    raise exception 'type 34 in any status is 3 and 1: %', r;
  end if;
  r := public.public_contract_search(status_filter => 'closed');
  if (r -> 'contracts' -> 0 ->> 'status') <> 'gone' or (r ->> 'total')::int <> 1 then
    raise exception 'closed search should find only gone contract 3: %', r;
  end if;

  -- A system finds the station, the structure and the archive's system_id.
  r := public.public_contract_search(system_ids => array[30000142]::bigint[]);
  select array_agg((c ->> 'contract_id')::bigint) into ids from json_array_elements(r -> 'contracts') c;
  if ids <> array[4, 1]::bigint[] then
    raise exception 'Jita should hold 4 and 1: %', r;
  end if;
  r := public.public_contract_search(system_ids => array[30000144]::bigint[]);
  if (r -> 'contracts' -> 0 ->> 'contract_id')::bigint <> 2
     or (r -> 'contracts' -> 0 ->> 'start_location_name') <> 'Perimeter - Tranquility Trading Tower'
     or (r -> 'contracts' -> 0 ->> 'start_system_id')::bigint <> 30000144 then
    raise exception 'Perimeter should hold 2, named through universe_structure: %', r;
  end if;
  r := public.public_contract_search(system_ids => array[30002187]::bigint[]);
  if (r -> 'contracts' -> 0 ->> 'contract_id')::bigint <> 5 or (r ->> 'total')::int <> 1 then
    raise exception 'Amarr should hold 5 through system_id: %', r;
  end if;

  -- Region, issuer (character or corporation), type.
  r := public.public_contract_search(region_ids => array[10000043]::bigint[]);
  if (r ->> 'total')::int <> 1 then raise exception 'one contract in 10000043: %', r; end if;
  r := public.public_contract_search(issuer_ids => array[98000001]::bigint[], status_filter => 'any');
  select array_agg((c ->> 'contract_id')::bigint) into ids from json_array_elements(r -> 'contracts') c;
  if ids <> array[3, 1]::bigint[] then
    raise exception 'corporation 98000001 issued 3 and 1: %', r;
  end if;
  r := public.public_contract_search(issuer_ids => array[90000004]::bigint[]);
  if (r -> 'contracts' -> 0 ->> 'contract_id')::bigint <> 4 then
    raise exception 'character 90000004 issued 4: %', r;
  end if;
  r := public.public_contract_search(contract_types => array['courier']);
  if (r ->> 'total')::int <> 1 or (r -> 'contracts' -> 0 ->> 'end_location_name') <> 'Perimeter - Tranquility Trading Tower' then
    raise exception 'one courier, to Perimeter: %', r;
  end if;

  -- A price bound drops the priceless courier; price sort is ascending.
  r := public.public_contract_search(max_price => 2000000, sort_order => 'price_asc');
  select array_agg((c ->> 'contract_id')::bigint) into ids from json_array_elements(r -> 'contracts') c;
  if ids <> array[5, 1]::bigint[] then
    raise exception 'under 2M ISK, cheapest first, is 5 then 1: %', r;
  end if;
  r := public.public_contract_search(issued_since => '2026-10-12T00:00:00Z');
  if (r ->> 'total')::int <> 2 then raise exception 'two outstanding issued since the 12th: %', r; end if;

  -- row_limit caps the rows, never the total; item_limit caps lines, never
  -- the line count; offered lines come before requested ones.
  r := public.public_contract_search(row_limit => 1);
  if json_array_length(r -> 'contracts') <> 1 or (r ->> 'total')::int <> 4 then
    raise exception 'one row of four: %', r;
  end if;
  r := public.public_contract_search(type_ids => array[34]::bigint[], item_limit => 1);
  if json_array_length(r -> 'contracts' -> 0 -> 'items') <> 1 or (r -> 'contracts' -> 0 ->> 'item_lines')::int <> 2 then
    raise exception 'one item line of two: %', r;
  end if;
  r := public.public_contract_search(system_ids => array[30000144]::bigint[]);
  if (r -> 'contracts' -> 0 -> 'items' -> 0 ->> 'is_included')::boolean is not true then
    raise exception 'offered lines first: %', r;
  end if;

  -- Nothing matched is an empty list, not null.
  r := public.public_contract_search(region_ids => array[1]::bigint[]);
  if (r ->> 'contracts') <> '[]' or (r ->> 'total')::int <> 0 then
    raise exception 'no match should be an empty list: %', r;
  end if;
end $$;

rollback;
