-- Rename the character_ids parameter to registration_ids on every function
-- that takes one — step 7 of docs/registration-id-rename.md. These arrays have
-- always held registration uuids; the columns they compare against were
-- renamed in steps 1-6, which is why the bodies currently read
-- `where o.registration_id = any(character_ids)`.
--
-- Every function here must be DROPPED and recreated, not replaced. Postgres
-- refuses to rename an input parameter through CREATE OR REPLACE:
--
--   ERROR:  cannot change name of input parameter "character_ids"
--   HINT:   Use DROP FUNCTION f(uuid[]) first.
--
-- Verified against a real Postgres rather than inferred. That makes this step
-- structurally different from #759/#760/#761, where only bodies moved.
--
-- Dropping is safe here: none of these is called from an RLS policy — they are
-- all reached over RPC — so nothing has to come down ahead of them. The DROPs
-- below name the OLD signature; a drop matches on parameter TYPES, which are
-- unchanged, so `(uuid[], timestamptz)` still resolves the pre-rename function.
--
-- Grants are re-applied because DROP discards the ACL.
--
-- THIS MIGRATION IS NOT BACKWARD COMPATIBLE and cannot be. supabase-js passes
-- RPC arguments BY NAME (`supabase.rpc('character_orders', { character_ids })`),
-- so the moment this lands, any deployment still sending character_ids gets
-- "function does not exist". Schema and callers must ship together — the
-- JavaScript half is in the same commit. The usual deploy-ordering window
-- (Migrate finishes before Vercel's build) is therefore a real, if brief,
-- outage for these seven endpoints rather than the harmless skew the earlier
-- column renames had.
--
-- blueprint_search() is the eighth and is redefined in the migration that
-- immediately follows, for the same reason as #761: test/sql/blueprint_search.sql
-- `\i`-includes the migration defining it, so that one has to live in a file
-- containing nothing but the function and its grant.

drop function if exists public.character_asset_snapshot_at(uuid[], timestamptz);
create function public.character_asset_snapshot_at(registration_ids uuid[], as_of timestamptz)
returns json
language sql
stable
as $$
  select coalesce(
    json_agg(
      json_build_object(
        'is_blueprint_copy', a.is_blueprint_copy,
        'is_singleton',      a.is_singleton,
        'item_id',           a.item_id,
        'location_flag',     a.location_flag,
        'location_id',       a.location_id,
        'location_type',     a.location_type,
        'quantity',          a.quantity,
        'type_id',           a.type_id,
        'character_name',    r.name,
        'type_name',         t.name
      )
      order by a.item_id
    ),
    '[]'::json
  )
  from public.character_asset_over_time a
  join public.registration r on r.id = a.registration_id
  left join public.sde_published_type t on t.type_id = a.type_id
  where a.registration_id = any(registration_ids)
    and a.valid_from <= as_of
    and (a.is_current or a.valid_until >= as_of)
    and (not a.is_singleton or a.is_blueprint_copy);
$$;

grant execute on function public.character_asset_snapshot_at(uuid[], timestamptz) to service_role;

drop function if exists public.character_blueprints(uuid[]);
create function public.character_blueprints(registration_ids uuid[])
returns json
language sql
stable
as $$
  select coalesce(
    json_agg(
      json_build_object(
        'item_id',             b.item_id,
        'location_flag',       b.location_flag,
        'location_id',         b.location_id,
        'material_efficiency', b.material_efficiency,
        'quantity',            b.quantity,
        'runs',                b.runs,
        'time_efficiency',     b.time_efficiency,
        'type_id',             b.type_id,
        'character_name',      r.name,
        'type_name',           t.name
      )
      order by b.item_id
    ),
    '[]'::json
  )
  from public.character_blueprint b
  join public.registration r on r.id = b.registration_id
  left join public.sde_published_type t on t.type_id = b.type_id
  where b.registration_id = any(registration_ids);
$$;

grant execute on function public.character_blueprints(uuid[]) to service_role;

drop function if exists public.character_orders(uuid[], timestamptz);
create function public.character_orders(registration_ids uuid[], as_of timestamptz default now())
returns json
language sql
stable
as $$
  select coalesce(
    json_agg(
      json_build_object(
        'duration',       o.duration,
        'escrow',         o.escrow,
        'is_buy_order',   o.is_buy,
        'is_corporation', o.is_corporation,
        'issued',         o.issued,
        'location_id',    o.location_id,
        'min_volume',     o.min_volume,
        'order_id',       o.order_id,
        'price',          o.price,
        'range',          o.range,
        'region_id',      o.region_id,
        'type_id',        o.type_id,
        'volume_remain',  o.volume_remain,
        'volume_total',   o.volume_total,
        'character_name', r.name,
        'type_name',      t.name
      )
      order by o.issued desc
    ),
    '[]'::json
  )
  from public.character_order_over_time o
  join public.registration r on r.id = o.registration_id
  left join public.sde_published_type t on t.type_id = o.type_id
  where o.registration_id = any(registration_ids)
    and o.valid_from <= as_of
    and (o.is_current or o.valid_until >= as_of);
$$;

grant execute on function public.character_orders(uuid[], timestamptz) to service_role;

drop function if exists public.character_industry_jobs(uuid[], boolean, timestamptz);
create function public.character_industry_jobs(registration_ids uuid[], include_delivered boolean default false, as_of timestamptz default now())
returns json
language sql
stable
as $$
  select coalesce(
    json_agg(
      json_build_object(
        'activity_id',            j.activity_id,
        'blueprint_id',           j.blueprint_id,
        'blueprint_location_id',  j.blueprint_location_id,
        'blueprint_type_id',      j.blueprint_type_id,
        'completed_character_id', j.completed_character_id,
        'completed_date',         j.completed_date,
        'cost',                   j.cost,
        'duration',               j.duration,
        'end_date',               j.end_date,
        'facility_id',            j.facility_id,
        'installer_id',           j.installer_id,
        'job_id',                 j.job_id,
        'licensed_runs',          j.licensed_runs,
        'output_location_id',     j.output_location_id,
        'pause_date',             j.pause_date,
        'probability',            j.probability,
        'product_type_id',        j.product_type_id,
        'runs',                   j.runs,
        'start_date',             j.start_date,
        'station_id',             j.station_id,
        'status',                 j.status,
        'successful_runs',        j.successful_runs,
        'character_name',         r.name,
        'blueprint_type_name',    bt.name,
        'product_type_name',      pt.name,
        'output_count',           j.runs * bp.product_quantity
      )
      order by j.start_date desc
    ),
    '[]'::json
  )
  from public.character_industry_job_over_time j
  join public.registration r on r.id = j.registration_id
  left join public.sde_published_type bt on bt.type_id = j.blueprint_type_id
  left join public.sde_published_type pt on pt.type_id = j.product_type_id
  left join public.sde_blueprint_product bp
    on bp.blueprint_type_id = j.blueprint_type_id
    -- ESI's job activity_id (9 = Reactions) doesn't match the SDE-internal
    -- dogma activity id sde_blueprint_product carries for the same activity
    -- (11); everything else (manufacturing = 1 in both) lines up already.
    and bp.activity_id = case j.activity_id when 9 then 11 else j.activity_id end
    and bp.product_type_id = j.product_type_id
  where j.registration_id = any(registration_ids)
    and j.valid_from <= as_of
    and (j.is_current or j.valid_until >= as_of)
    and (include_delivered or j.status not in ('delivered', 'cancelled', 'archived'));
$$;

grant execute on function public.character_industry_jobs(uuid[], boolean, timestamptz) to service_role;

drop function if exists public.corp_assets(uuid[]);
create function public.corp_assets(registration_ids uuid[])
returns json
language sql
stable
as $$
  select coalesce(
    json_agg(
      json_build_object(
        'item_id',           a.item_id,
        'corporation_id',    a.corporation_id,
        'type_id',           a.type_id,
        'location_id',       a.location_id,
        'location_flag',     a.location_flag,
        'location_type',     a.location_type,
        'quantity',          a.quantity,
        'is_singleton',      a.is_singleton,
        'is_blueprint_copy', a.is_blueprint_copy,
        'type_name',         t.name
      )
      order by a.item_id
    ),
    '[]'::json
  )
  from public.corp_asset a
  left join public.sde_published_type t on t.type_id = a.type_id
  where a.corporation_id in (
    select corporation_id from public.registration
    where id = any(registration_ids) and corporation_id is not null
  );
$$;

grant execute on function public.corp_assets(uuid[]) to service_role;

drop function if exists public.corp_blueprints(uuid[]);
create function public.corp_blueprints(registration_ids uuid[])
returns json
language sql
stable
as $$
  select coalesce(
    json_agg(
      json_build_object(
        'item_id',             b.item_id,
        'corporation_id',      b.corporation_id,
        'location_flag',       b.location_flag,
        'location_id',         b.location_id,
        'material_efficiency', b.material_efficiency,
        'quantity',            b.quantity,
        'runs',                b.runs,
        'time_efficiency',     b.time_efficiency,
        'type_id',             b.type_id,
        'type_name',           t.name
      )
      order by b.item_id
    ),
    '[]'::json
  )
  from public.corp_blueprint b
  left join public.sde_published_type t on t.type_id = b.type_id
  where b.corporation_id in (
    select corporation_id from public.registration
    where id = any(registration_ids) and corporation_id is not null
  );
$$;

grant execute on function public.corp_blueprints(uuid[]) to service_role;

drop function if exists public.corp_industry_jobs(uuid[], boolean, timestamptz);
create function public.corp_industry_jobs(registration_ids uuid[], include_delivered boolean default false, as_of timestamptz default now())
returns json
language sql
stable
as $$
  select coalesce(
    json_agg(
      json_build_object(
        'activity_id',            j.activity_id,
        'blueprint_id',           j.blueprint_id,
        'blueprint_location_id',  j.blueprint_location_id,
        'blueprint_type_id',      j.blueprint_type_id,
        'completed_character_id', j.completed_character_id,
        'completed_date',         j.completed_date,
        'corporation_id',         j.corporation_id,
        'cost',                   j.cost,
        'duration',               j.duration,
        'end_date',               j.end_date,
        'facility_id',            j.facility_id,
        'installer_id',           j.installer_id,
        'job_id',                 j.job_id,
        'licensed_runs',          j.licensed_runs,
        'output_location_id',     j.output_location_id,
        'pause_date',             j.pause_date,
        'probability',            j.probability,
        'product_type_id',        j.product_type_id,
        'runs',                   j.runs,
        'start_date',             j.start_date,
        'station_id',             j.station_id,
        'status',                 j.status,
        'successful_runs',        j.successful_runs,
        'blueprint_type_name',    bt.name,
        'product_type_name',      pt.name,
        'output_count',           j.runs * bp.product_quantity
      )
      order by j.start_date desc
    ),
    '[]'::json
  )
  from public.corp_industry_job_over_time j
  left join public.sde_published_type bt on bt.type_id = j.blueprint_type_id
  left join public.sde_published_type pt on pt.type_id = j.product_type_id
  left join public.sde_blueprint_product bp
    on bp.blueprint_type_id = j.blueprint_type_id
    -- ESI's job activity_id (9 = Reactions) doesn't match the SDE-internal
    -- dogma activity id sde_blueprint_product carries for the same activity
    -- (11); everything else (manufacturing = 1 in both) lines up already.
    and bp.activity_id = case j.activity_id when 9 then 11 else j.activity_id end
    and bp.product_type_id = j.product_type_id
  where j.corporation_id in (
    select corporation_id from public.registration
    where id = any(registration_ids) and corporation_id is not null
  )
  and j.valid_from <= as_of
  and (j.is_current or j.valid_until >= as_of)
  and (include_delivered or j.status not in ('delivered', 'cancelled', 'archived'));
$$;

grant execute on function public.corp_industry_jobs(uuid[], boolean, timestamptz) to service_role;

-- Assert every function came back with the new parameter name and none kept
-- the old one. A DROP that succeeded followed by a CREATE that quietly kept
-- character_ids would leave the database working and every caller in this same
-- commit broken, which is the one failure this migration can actually produce.
do $$
declare
  fn text;
  n integer;
begin
  foreach fn in array array['character_asset_snapshot_at', 'character_blueprints',
                            'character_orders', 'character_industry_jobs',
                            'corp_assets', 'corp_blueprints', 'corp_industry_jobs'] loop
    select count(*) into n
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
    cross join unnest(p.proargnames) as arg
    where ns.nspname = 'public' and p.proname = fn and arg = 'registration_ids';
    if n = 0 then
      raise exception '%() does not take a registration_ids parameter', fn;
    end if;

    select count(*) into n
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
    cross join unnest(p.proargnames) as arg
    where ns.nspname = 'public' and p.proname = fn and arg = 'character_ids';
    if n > 0 then
      raise exception '%() still takes a character_ids parameter — its callers ship in this commit and would break', fn;
    end if;
  end loop;
end $$;
