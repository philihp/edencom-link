-- blueprint_search(): the MCP list_blueprints query, done entirely in SQL.
-- Implements section 1 of docs/mcp-tools-spec.md.
--
-- The tool used to drain every character_blueprint and corp_blueprint row
-- through PostgREST and then filter, sort and slice them in JS — which is why
-- it answered "Showing the first 200 of 10968 blueprints" and could not scope
-- to a location at all. That post-fetch slicing is the defect being fixed here:
-- the character/corp union, the location→system resolution, every filter, the
-- collapse, and the limit all happen in one query, and the returned json's
-- totals cover the *whole* filtered set while only `row_limit` rows travel over
-- the wire.
--
-- Access model: `language sql stable` with no security definer, so it runs as
-- the caller and the character_blueprint / corp_blueprint views (security
-- invoker over RLS-enabled tables, already scoped to is_current) constrain the
-- result exactly like a direct select would — same shape as
-- character_asset_search().
--
-- Parameter names are plural/suffixed so none collides with a column name in
-- the body (an unqualified name matching both is an ambiguity error in a
-- SQL-language function).
--
--   type_ids          null = every type, else the resolved item-name matches
--   system_ids        null = everywhere, else solar systems to scope to
--   structure_ids     null = anywhere, else structures to scope to
--   character_ids     null = every character; '{}' excludes all character rows
--   corporation_ids   null = every corporation; '{}' excludes all corp rows
--   kind_filter       'all' (default) | 'original' | 'copy'
--   below_me/below_te research floors, OR'd when both are given (see below)
--   researchable_only exclude types that cannot be researched at all
--   group_mode        'none' | 'type' | 'type_location'
--   row_limit         display cap; totals always cover everything

create or replace function public.blueprint_search(
  type_ids bigint[] default null,
  system_ids bigint[] default null,
  structure_ids bigint[] default null,
  character_ids uuid[] default null,
  corporation_ids bigint[] default null,
  kind_filter text default 'all',
  below_me int default null,
  below_te int default null,
  researchable_only boolean default false,
  group_mode text default 'none',
  row_limit int default 100
)
returns json
language sql
stable
as $$
  with owned as (
    -- ESI encoding: `runs = -1` marks an original; any other value is a copy
    -- with that many runs left. `quantity` carries its own sentinels (-1
    -- singleton, -2 BPC stack) and must never be summed raw, so it is
    -- normalised to a real item count here and nowhere else.
    select
      b.type_id::bigint                                    as type_id,
      b.character_id::text                                 as owner_id,
      'character'::text                                    as owner_kind,
      b.location_id::bigint                                as location_id,
      b.location_flag                                      as location_flag,
      case when b.runs = -1 or b.runs is null then 'original' else 'copy' end as kind,
      b.material_efficiency                                as material_efficiency,
      b.time_efficiency                                    as time_efficiency,
      b.runs                                               as runs,
      case when b.quantity > 0 then b.quantity else 1 end  as quantity
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
      case when b.runs = -1 or b.runs is null then 'original' else 'copy' end,
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
  -- two sources resolveLocations() uses in the app. KNOWN LIMITATION (called
  -- out in the spec): a blueprint inside a container or ship has an item id
  -- here, not a structure id, so it resolves to no system and drops out of a
  -- location-scoped query. Container traversal is out of scope for this change.
  located as (
    select
      o.*,
      coalesce(st.system_id, us.system_id) as system_id,
      coalesce(st.name, us.name)           as location_name,
      -- Researchable = the blueprint has a manufacturing activity. Reaction
      -- formulas only ever have the reaction activity (11); they cannot be
      -- researched, always report ME/TE 0/0, and would otherwise flood any
      -- "still needs research" result. Deriving this from the activity the SDE
      -- actually records beats both name matching (fragile, per the spec) and a
      -- hardcoded list of reaction-formula group ids.
      exists (
        select 1 from public.sde_blueprint_product bp
        where bp.blueprint_type_id = o.type_id and bp.activity_id = 1
      ) as researchable
    from owned o
    left join public.sde_station st        on st.station_id = o.location_id
    left join public.universe_structure us on us.structure_id = o.location_id
  ),
  filtered as (
    select *
    from located
    where (system_ids is null or system_id = any(system_ids))
      and (structure_ids is null or location_id = any(structure_ids))
      and (kind_filter is null or kind_filter = 'all' or kind = kind_filter)
      and (not researchable_only or researchable)
      -- below_me and below_te are OR'd when both are given: "short of either
      -- target", which is how the question is actually asked ("which blueprints
      -- are not at 10/20 yet"). Deliberately not the obvious AND reading.
      and (
        (below_me is null and below_te is null)
        or (below_me is not null and coalesce(material_efficiency, 0) < below_me)
        or (below_te is not null and coalesce(time_efficiency, 0) < below_te)
      )
  ),
  named as (
    select f.*, coalesce(t.name, 'Type #' || f.type_id) as type_name
    from filtered f
    left join public.sde_published_type t on t.type_id = f.type_id
  ),
  totals as (
    select
      count(*)                                    as total_stacks,
      coalesce(sum(quantity), 0)                  as total_quantity,
      (count(*) filter (where kind = 'original')) as originals,
      (count(*) filter (where kind = 'copy'))     as copies,
      count(distinct type_id)                     as distinct_types
    from named
  ),
  -- 'type' collapses identical (type, ME, TE) rows into one carrying a count —
  -- the fix for a hangar holding 37 indistinguishable copies of one BPC.
  -- 'type_location' keeps them split per location. `stacks` sums back to
  -- total_stacks across the whole grouped set.
  grouped as (
    select
      type_id,
      type_name,
      material_efficiency,
      time_efficiency,
      case when group_mode = 'type_location' then location_id end   as location_id,
      case when group_mode = 'type_location' then location_name end as location_name,
      case when group_mode = 'type_location' then system_id end     as system_id,
      count(*)                                                as stacks,
      coalesce(sum(quantity), 0)                              as quantity,
      (count(*) filter (where kind = 'original'))             as originals,
      (count(*) filter (where kind = 'copy'))                 as copies,
      coalesce(sum(runs) filter (where kind = 'copy'), 0)     as copy_runs,
      bool_or(researchable)                                   as researchable
    from named
    group by
      type_id,
      type_name,
      material_efficiency,
      time_efficiency,
      case when group_mode = 'type_location' then location_id end,
      case when group_mode = 'type_location' then location_name end,
      case when group_mode = 'type_location' then system_id end
  ),
  capped as (
    select least(greatest(coalesce(row_limit, 100), 1), 500) as n
  )
  select json_build_object(
    'group',          case when group_mode in ('type', 'type_location') then group_mode else 'none' end,
    'total_stacks',   (select total_stacks   from totals),
    'total_quantity', (select total_quantity from totals),
    'originals',      (select originals      from totals),
    'copies',         (select copies         from totals),
    'distinct_types', (select distinct_types from totals),
    'total_groups',   case when group_mode in ('type', 'type_location') then (select count(*) from grouped) end,
    'rows',
      case when group_mode in ('type', 'type_location') then
        coalesce(
          (
            select json_agg(
              json_build_object(
                'type_id',             g.type_id,
                'type_name',           g.type_name,
                'material_efficiency', g.material_efficiency,
                'time_efficiency',     g.time_efficiency,
                'stacks',              g.stacks,
                'quantity',            g.quantity,
                'originals',           g.originals,
                'copies',              g.copies,
                'copy_runs',           g.copy_runs,
                'researchable',        g.researchable,
                'location_id',         g.location_id,
                'location_name',       g.location_name,
                'system_id',           g.system_id
              )
              order by g.stacks desc, g.type_name, g.material_efficiency, g.time_efficiency
            )
            from (
              select * from grouped
              order by stacks desc, type_name, material_efficiency, time_efficiency
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
                'researchable',        d.researchable,
                'location_id',         d.location_id,
                'location_name',       d.location_name,
                'location_flag',       d.location_flag,
                'system_id',           d.system_id
              )
              order by d.type_name, d.material_efficiency, d.time_efficiency, d.owner_id, d.location_id
            )
            from (
              select * from named
              order by type_name, material_efficiency, time_efficiency, owner_id, location_id
              limit (select n from capped)
            ) d
          ),
          '[]'::json
        )
      end
  );
$$;

grant execute on function public.blueprint_search(
  bigint[], bigint[], bigint[], uuid[], bigint[], text, int, int, boolean, text, int
) to authenticated;
