-- Corp assets and corp industry jobs, mirroring the existing per-corp tables
-- (corp_structure, corp_wallet_journal, corp_market_transaction) and exposing
-- them via IMPORTDATA-style RPCs (/api/corp/assets, /api/corp/jobs), like
-- asset_snapshot_at()/industry_jobs() do for the per-character endpoints.

-- ── corp_asset_over_time ──────────────────────────────────────────────────
-- SCD Type 2 history, mirroring asset_over_time for per-character assets.
create table if not exists public.corp_asset_over_time (
  id bigint generated always as identity primary key,
  item_id bigint not null,
  corporation_id bigint not null,
  type_id bigint not null,
  location_id bigint,
  location_flag text,
  location_type text,
  quantity bigint,
  is_singleton boolean,
  is_blueprint_copy boolean,
  is_current boolean not null default true,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists corp_asset_over_time_corporation_id_idx on public.corp_asset_over_time (corporation_id);
create unique index if not exists corp_asset_over_time_current_item_idx
  on public.corp_asset_over_time (item_id) where is_current;
create index if not exists corp_asset_over_time_item_id_idx
  on public.corp_asset_over_time (item_id, last_seen_at desc);

alter table public.corp_asset_over_time enable row level security;

drop policy if exists "Users read assets for own corps" on public.corp_asset_over_time;
create policy "Users read assets for own corps"
  on public.corp_asset_over_time
  for select
  to authenticated
  using (
    corporation_id in (
      select corporation_id from public.registration
      where user_id = (select auth.uid()) and corporation_id is not null
    )
  );

drop view if exists public.corp_asset;
create view public.corp_asset with (security_invoker = on) as
  select * from public.corp_asset_over_time where is_current;

grant select on public.corp_asset_over_time to authenticated;
grant select on public.corp_asset           to authenticated;
grant all    on public.corp_asset_over_time to service_role;

create or replace function public.corp_assets(character_ids uuid[])
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
        'is_blueprint_copy', a.is_blueprint_copy
      )
      order by a.item_id
    ),
    '[]'::json
  )
  from public.corp_asset a
  where a.corporation_id in (
    select corporation_id from public.registration
    where id = any(character_ids) and corporation_id is not null
  );
$$;

grant execute on function public.corp_assets(uuid[]) to service_role;

-- ── corp_industry_job ─────────────────────────────────────────────────────
create table if not exists public.corp_industry_job (
  job_id bigint primary key,
  corporation_id bigint not null,
  installer_id bigint not null,
  facility_id bigint not null,
  station_id bigint,
  activity_id smallint not null,
  blueprint_id bigint not null,
  blueprint_type_id bigint not null,
  blueprint_location_id bigint not null,
  output_location_id bigint not null,
  product_type_id bigint,
  runs integer not null,
  cost numeric(20, 2),
  licensed_runs integer,
  probability real,
  status text not null,
  duration integer not null,
  start_date timestamptz not null,
  end_date timestamptz not null,
  pause_date timestamptz,
  completed_date timestamptz,
  completed_character_id bigint,
  successful_runs integer,
  seen_at timestamptz not null default now()
);
create index if not exists corp_industry_job_corporation_id_end_date_idx
  on public.corp_industry_job (corporation_id, end_date desc);

alter table public.corp_industry_job enable row level security;

drop policy if exists "Users read industry jobs for own corps" on public.corp_industry_job;
create policy "Users read industry jobs for own corps"
  on public.corp_industry_job
  for select
  to authenticated
  using (
    corporation_id in (
      select corporation_id from public.registration
      where user_id = (select auth.uid()) and corporation_id is not null
    )
  );

grant select on public.corp_industry_job to authenticated;
grant all    on public.corp_industry_job to service_role;

create or replace function public.corp_industry_jobs(character_ids uuid[], include_delivered boolean default false)
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
  from public.corp_industry_job j
  where j.corporation_id in (
    select corporation_id from public.registration
    where id = any(character_ids) and corporation_id is not null
  )
  and (include_delivered or j.status not in ('delivered', 'cancelled', 'archived'));
$$;

grant execute on function public.corp_industry_jobs(uuid[], boolean) to service_role;
