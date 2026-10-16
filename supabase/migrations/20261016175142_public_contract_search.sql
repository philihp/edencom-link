-- public_contract_search(): the MCP search_public_contracts query, done in SQL
-- (docs/public-contracts.md). Every filter, the count and the limit happen in
-- one query, so the total covers the whole filtered set while only
-- `row_limit` contracts travel over the wire, each carrying its first
-- `item_limit` item lines.
--
-- Access model: `language sql stable`, no security definer. The
-- public_contract* tables are members-read, so the function reads exactly
-- what a direct select by the caller would.
--
--   type_ids        null = any contents, else contracts OFFERING one of these
--                   types (is_included; an item asked for does not match)
--   region_ids      null = everywhere, else the contract's region
--   system_ids      null = everywhere, else the contract's start location is
--                   in one of these systems: an NPC station (sde_station), a
--                   player structure we know of (universe_structure), or the
--                   archive's resolved system_id
--   issuer_ids      null = anyone, else the issuing character OR corporation
--   contract_types  null = every type, else ESI's type names
--   status_filter   'outstanding' (default) | 'closed' | 'any'
--   min_price/max_price  bounds on `price` (an auction's starting bid); a
--                   contract with no price (a courier) never passes a bound
--   issued_since    only contracts issued at or after this moment
--   sort_order      'newest' (default) | 'price_asc' | 'price_desc'
--   row_limit       display cap, 1..200; the total covers everything
--   item_limit      item lines itemised per contract, 0..100

create or replace function public.public_contract_search(
  type_ids bigint[] default null,
  region_ids bigint[] default null,
  system_ids bigint[] default null,
  issuer_ids bigint[] default null,
  contract_types text[] default null,
  status_filter text default 'outstanding',
  min_price numeric default null,
  max_price numeric default null,
  issued_since timestamptz default null,
  sort_order text default 'newest',
  row_limit int default 50,
  item_limit int default 25
)
returns json
language sql
stable
as $$
  with matched as (
    select c.*, s.status, s.valid_from as status_since
    from public.public_contract c
    join public.public_contract_status s on s.contract_id = c.contract_id
    where (type_ids is null or c.contract_id in (
            select i.contract_id from public.public_contract_item i
            where i.type_id = any(type_ids) and i.is_included
          ))
      and (region_ids is null or c.region_id = any(region_ids))
      and (system_ids is null
           or c.system_id = any(system_ids)
           or c.start_location_id in (select st.station_id from public.sde_station st where st.system_id = any(system_ids))
           or c.start_location_id in (select us.structure_id from public.universe_structure us where us.system_id = any(system_ids)))
      and (issuer_ids is null or c.issuer_id = any(issuer_ids) or c.issuer_corporation_id = any(issuer_ids))
      and (contract_types is null or c.type = any(contract_types))
      and (case coalesce(status_filter, 'outstanding')
             when 'any' then true
             when 'closed' then s.status <> 'outstanding'
             else s.status = 'outstanding'
           end)
      and (min_price is null or c.price >= min_price)
      and (max_price is null or c.price <= max_price)
      and (issued_since is null or c.date_issued >= issued_since)
  ),
  capped as (
    select
      least(greatest(coalesce(row_limit, 50), 1), 200) as n,
      least(greatest(coalesce(item_limit, 25), 0), 100) as items
  ),
  page as (
    select m.*
    from matched m
    order by
      case when sort_order = 'price_asc' then m.price end asc nulls last,
      case when sort_order = 'price_desc' then m.price end desc nulls last,
      m.date_issued desc,
      m.contract_id desc
    limit (select n from capped)
  )
  select json_build_object(
    'total', (select count(*) from matched),
    'contracts', coalesce(
      (
        select json_agg(
          json_build_object(
            'contract_id',           p.contract_id,
            'type',                  p.type,
            'status',                p.status,
            'status_since',          p.status_since,
            'title',                 p.title,
            'region_id',             p.region_id,
            'start_location_id',     p.start_location_id,
            'start_location_name',   coalesce(sst.name, sus.name),
            'start_system_id',       coalesce(p.system_id, sst.system_id, sus.system_id),
            'end_location_id',       p.end_location_id,
            'end_location_name',     coalesce(est.name, eus.name),
            'end_system_id',         coalesce(est.system_id, eus.system_id),
            'issuer_id',             p.issuer_id,
            'issuer_corporation_id', p.issuer_corporation_id,
            'for_corporation',       p.for_corporation,
            'price',                 p.price,
            'buyout',                p.buyout,
            'reward',                p.reward,
            'collateral',            p.collateral,
            'volume',                p.volume,
            'days_to_complete',      p.days_to_complete,
            'date_issued',           p.date_issued,
            'date_expired',          p.date_expired,
            'items_fetched',         p.items_fetched_at is not null,
            'item_lines',            (select count(*) from public.public_contract_item i where i.contract_id = p.contract_id),
            'items', coalesce(
              (
                select json_agg(
                  json_build_object(
                    'type_id',             i.type_id,
                    'quantity',            i.quantity,
                    'is_included',         i.is_included,
                    'is_blueprint_copy',   i.is_blueprint_copy,
                    'material_efficiency', i.material_efficiency,
                    'time_efficiency',     i.time_efficiency,
                    'runs',                i.runs
                  )
                  order by i.is_included desc, i.record_id
                )
                from (
                  select * from public.public_contract_item i
                  where i.contract_id = p.contract_id
                  order by i.is_included desc, i.record_id
                  limit (select items from capped)
                ) i
              ),
              '[]'::json
            )
          )
          order by
            case when sort_order = 'price_asc' then p.price end asc nulls last,
            case when sort_order = 'price_desc' then p.price end desc nulls last,
            p.date_issued desc,
            p.contract_id desc
        )
        from page p
        left join public.sde_station sst        on sst.station_id = p.start_location_id
        left join public.universe_structure sus on sus.structure_id = p.start_location_id
        left join public.sde_station est        on est.station_id = p.end_location_id
        left join public.universe_structure eus on eus.structure_id = p.end_location_id
      ),
      '[]'::json
    )
  );
$$;

grant execute on function public.public_contract_search(
  bigint[], bigint[], bigint[], bigint[], text[], text, numeric, numeric, timestamptz, text, int, int
) to authenticated;
