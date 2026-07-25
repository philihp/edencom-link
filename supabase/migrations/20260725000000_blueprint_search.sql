-- blueprint_search(): the MCP list_blueprints tool's query, done entirely in
-- SQL. The tool used to drain every character_blueprint and corp_blueprint row
-- through PostgREST and filter/sort/slice them in JS — fine for a handful of
-- blueprints, wasteful for an industry corp with five figures of them. This
-- folds the character/corp union, the location→system resolution, every
-- filter, the by-type stack collapse, and the display cap into one query, and
-- returns a single json payload whose totals cover the *whole* filtered set
-- while only `row_limit` rows travel over the wire.
--
-- Access model: `language sql stable` with no security definer, so it runs as
-- the caller and the character_blueprint / corp_blueprint views (security
-- invoker over RLS-enabled tables) scope the result exactly like a direct
-- select would — same shape as character_asset_search().
--
-- Parameter names are all plural/prefixed so none collides with a column name
-- in the body (an unqualified name that matches both is an ambiguity error in
-- a SQL-language function).
--
--   type_ids        null = every type, else the resolved item-name matches
--   system_ids      null = everywhere, else solar systems to scope to
--   character_ids   null = every character; '{}' excludes all character rows
--   corporation_ids null = every corporation; '{}' excludes all corp rows
--   kind_filter     null | 'original' | 'copy'
--   min_me/min_te   null = no floor, else minimum researched level
--   group_mode      'none' (one row per stack) | 'type' (collapse by type)
--   row_limit       display cap; totals always cover everything

create or replace function public.blueprint_search(
  type_ids bigint[] default null,
  system_ids bigint[] default null,
  character_ids uuid[] default null,
  corporation_ids bigint[] default null,
  kind_filter text default null,
  min_me int default null,
  min_te int default null,
  group_mode text default 'none',
  row_limit int default 200
)
returns json
language sql
stable
as $$
  with owned as (
    -- ESI blueprint quantity: -2 is a copy, -1 a researched original, a
    -- positive number a stack of unresearched originals.
    select
      b.type_id::bigint                                        as type_id,
      b.character_id::text                                     as owner_id,
      'character'::text                                        as owner_kind,
      b.location_id::bigint                                    as location_id,
      b.location_flag                                          as location_flag,
      case when b.quantity = -2 then 'copy' else 'original' end as kind,
      b.material_efficiency                                    as material_efficiency,
      b.time_efficiency                                        as time_efficiency,
      b.runs                                                   as runs,
      case when b.quantity > 0 then b.quantity else 1 end      as quantity
    from public.character_blueprint b
    where (type_ids is null or b.type_id = any(type_ids))
      and (character_ids is null or b.character_id = any(character_ids))
    union all
    select
      b.type_id::bigint,
      b.corporation_id::text,
      'corporation'::text,
      b.location_id::bigint,
      b.location_flag,
      case when b.quantity = -2 then 'copy' else 'original' end,
      b.material_efficiency,
      b.time_efficiency,
      b.runs,
      case when b.quantity > 0 then b.quantity else 1 end
    from public.corp_blueprint b
    where (type_ids is null or b.type_id = any(type_ids))
      and (corporation_ids is null or b.corporation_id = any(corporation_ids))
  ),
  -- Blueprints carry a bare location_id. NPC stations resolve through the SDE
  -- mirror, player structures through the universe_structure cache — the same
  -- two sources resolveLocations() uses in the app. A blueprint sitting in a
  -- container or ship keeps a null system_id (its location_id is an item, not
  -- a station), so a system filter excludes it; that matches what the tool has
  -- always been able to *display* for such rows.
  located as (
    select
      o.*,
      coalesce(st.system_id, us.system_id) as system_id,
      coalesce(st.name, us.name)           as location_name
    from owned o
    left join public.sde_station st        on st.station_id = o.location_id
    left join public.universe_structure us on us.structure_id = o.location_id
  ),
  filtered as (
    select *
    from located
    where (system_ids is null or system_id = any(system_ids))
      and (kind_filter is null or kind = kind_filter)
      and (min_me is null or coalesce(material_efficiency, 0) >= min_me)
      and (min_te is null or coalesce(time_efficiency, 0) >= min_te)
  ),
  named as (
    select f.*, coalesce(t.name, 'Type #' || f.type_id) as type_name
    from filtered f
    left join public.sde_published_type t on t.type_id = f.type_id
  ),
  totals as (
    select
      count(*)                                          as total_stacks,
      coalesce(sum(quantity), 0)                        as total_quantity,
      (count(*) filter (where kind = 'original'))       as originals,
      (count(*) filter (where kind = 'copy'))           as copies,
      count(distinct type_id)                           as distinct_types
    from named
  ),
  grouped as (
    select
      type_id,
      type_name,
      count(*)                                                as stacks,
      coalesce(sum(quantity), 0)                              as quantity,
      (count(*) filter (where kind = 'original'))             as originals,
      (count(*) filter (where kind = 'copy'))                 as copies,
      max(material_efficiency)                                as best_material_efficiency,
      max(time_efficiency)                                    as best_time_efficiency,
      coalesce(sum(runs) filter (where kind = 'copy'), 0)     as copy_runs,
      count(distinct system_id)                               as systems
    from named
    group by type_id, type_name
  ),
  capped as (
    select least(greatest(coalesce(row_limit, 200), 1), 1000) as n
  )
  select json_build_object(
    'group',          case when group_mode = 'type' then 'type' else 'none' end,
    'total_stacks',   (select total_stacks   from totals),
    'total_quantity', (select total_quantity from totals),
    'originals',      (select originals      from totals),
    'copies',         (select copies         from totals),
    'distinct_types', (select distinct_types from totals),
    'rows',
      case when group_mode = 'type' then
        coalesce(
          (
            select json_agg(
              json_build_object(
                'type_id',                  g.type_id,
                'type_name',                g.type_name,
                'stacks',                   g.stacks,
                'quantity',                 g.quantity,
                'originals',                g.originals,
                'copies',                   g.copies,
                'best_material_efficiency', g.best_material_efficiency,
                'best_time_efficiency',     g.best_time_efficiency,
                'copy_runs',                g.copy_runs,
                'systems',                  g.systems
              )
              order by g.quantity desc, g.type_name
            )
            from (
              select * from grouped
              order by quantity desc, type_name
              limit (select n from capped)
            ) g
          ),
          '[]'::json
        )
      else
        coalesce(
          (
            select json_agg(
              json_build_object(
                'type_id',             d.type_id,
                'type_name',           d.type_name,
                'owner_id',            d.owner_id,
                'owner_kind',          d.owner_kind,
                'kind',                d.kind,
                'material_efficiency', d.material_efficiency,
                'time_efficiency',     d.time_efficiency,
                'runs',                d.runs,
                'quantity',            d.quantity,
                'location_id',         d.location_id,
                'location_name',       d.location_name,
                'location_flag',       d.location_flag,
                'system_id',           d.system_id
              )
              order by d.type_name, d.owner_id, d.location_id
            )
            from (
              select * from named
              order by type_name, owner_id, location_id
              limit (select n from capped)
            ) d
          ),
          '[]'::json
        )
      end
  );
$$;

grant execute on function public.blueprint_search(
  bigint[], bigint[], uuid[], bigint[], text, int, int, text, int
) to authenticated;
