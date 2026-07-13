-- Give the market-orders and industry-jobs IMPORTDATA functions an `as_of`
-- parameter (default now) so their /api endpoints can accept an `at=` query
-- param and reconstruct the snapshot at any past moment from the SCD-2 history,
-- exactly like character_asset_snapshot_at already does for assets. Each reads
-- its *_over_time history table and keeps the version of every order/job that
-- was valid at `as_of` (started by then, and either still open then or the
-- current version). At the default now() this returns the same is_current set
-- the views exposed, so existing callers are unaffected.
--
-- Adding a parameter creates a new overload that would make the old one-/two-arg
-- form ambiguous, so drop the prior signatures first.

drop function if exists public.character_orders(uuid[]);
create or replace function public.character_orders(character_ids uuid[], as_of timestamptz default now())
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
        'character_name', r.name
      )
      order by o.issued desc
    ),
    '[]'::json
  )
  from public.character_order_over_time o
  join public.registration r on r.id = o.character_id
  where o.character_id = any(character_ids)
    and o.valid_from <= as_of
    and (o.valid_until >= as_of or o.is_current);
$$;

grant execute on function public.character_orders(uuid[], timestamptz) to service_role;

drop function if exists public.character_industry_jobs(uuid[], boolean);
create or replace function public.character_industry_jobs(character_ids uuid[], include_delivered boolean default false, as_of timestamptz default now())
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
        'character_name',         r.name
      )
      order by j.start_date desc
    ),
    '[]'::json
  )
  from public.character_industry_job_over_time j
  join public.registration r on r.id = j.character_id
  where j.character_id = any(character_ids)
    and j.valid_from <= as_of
    and (j.valid_until >= as_of or j.is_current)
    and (include_delivered or j.status not in ('delivered', 'cancelled', 'archived'));
$$;

grant execute on function public.character_industry_jobs(uuid[], boolean, timestamptz) to service_role;

drop function if exists public.corp_industry_jobs(uuid[], boolean);
create or replace function public.corp_industry_jobs(character_ids uuid[], include_delivered boolean default false, as_of timestamptz default now())
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
        'successful_runs',        j.successful_runs
      )
      order by j.start_date desc
    ),
    '[]'::json
  )
  from public.corp_industry_job_over_time j
  where j.corporation_id in (
    select corporation_id from public.registration
    where id = any(character_ids) and corporation_id is not null
  )
  and j.valid_from <= as_of
  and (j.valid_until >= as_of or j.is_current)
  and (include_delivered or j.status not in ('delivered', 'cancelled', 'archived'));
$$;

grant execute on function public.corp_industry_jobs(uuid[], boolean, timestamptz) to service_role;
