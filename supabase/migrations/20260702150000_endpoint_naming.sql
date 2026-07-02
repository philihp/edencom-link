-- Rename the extract data model so every table is named after the ESI endpoint
-- that feeds it, prefixed by owner scope (character_*, corp_*, universe_*):
--
--   wallet                  -> character_wallet             (/characters/{id}/wallet/)
--   market_transaction      -> character_wallet_transaction (/characters/{id}/wallet/transactions/)
--   market_order            -> character_order              (/characters/{id}/orders/)
--   industry_job            -> character_industry_job       (/characters/{id}/industry/jobs/)
--   asset_over_time         -> character_asset_over_time    (/characters/{id}/assets/)
--   asset (view)            -> character_asset
--   corp_market_transaction -> corp_wallet_transaction      (/corporations/{id}/wallets/{division}/transactions/)
--   character_corp          -> character_affiliation        (/characters/affiliation/)
--   eve_name                -> universe_name                (/universe/names/)
--   structure               -> universe_structure           (/universe/structures/{id})
--
-- The character-side SQL functions are dropped and recreated under matching
-- names: their bodies are stored as text, so the table renames would break them
-- anyway. RLS policies and grants ride along with the renamed tables.

-- ── tables & views ───────────────────────────────────────────────────────────
alter table public.wallet                  rename to character_wallet;
alter table public.market_transaction      rename to character_wallet_transaction;
alter table public.market_order            rename to character_order;
alter table public.industry_job            rename to character_industry_job;
alter table public.asset_over_time         rename to character_asset_over_time;
alter view  public.asset                   rename to character_asset;
alter table public.corp_market_transaction rename to corp_wallet_transaction;
alter table public.character_corp          rename to character_affiliation;
alter table public.eve_name                rename to universe_name;
alter table public.structure               rename to universe_structure;

-- ── indexes ──────────────────────────────────────────────────────────────────
alter index public.wallet_character_id_recorded_at_idx      rename to character_wallet_character_id_recorded_at_idx;
alter index public.market_transaction_character_id_date_idx rename to character_wallet_transaction_character_id_date_idx;
alter index public.market_order_character_id_issued_idx     rename to character_order_character_id_issued_idx;
alter index public.industry_job_character_id_end_date_idx   rename to character_industry_job_character_id_end_date_idx;
alter index public.asset_over_time_character_id_idx         rename to character_asset_over_time_character_id_idx;
alter index public.asset_over_time_current_item_idx         rename to character_asset_over_time_current_item_idx;
alter index public.asset_over_time_item_id_idx              rename to character_asset_over_time_item_id_idx;
alter index public.corp_market_transaction_character_id_date_idx rename to corp_wallet_transaction_character_id_date_idx;

-- ── policies whose names quoted the old table names ─────────────────────────
alter policy "Authenticated read eve_name"       on public.universe_name         rename to "Authenticated read universe_name";
alter policy "Authenticated read character_corp" on public.character_affiliation rename to "Authenticated read character_affiliation";
alter policy "Authenticated read structure"      on public.universe_structure    rename to "Authenticated read universe_structure";

-- ── functions ────────────────────────────────────────────────────────────────
drop function if exists public.asset_location_summary();
drop function if exists public.asset_location_contents(bigint);
drop function if exists public.asset_snapshot_at(uuid[], timestamptz);
drop function if exists public.industry_jobs(uuid[], boolean);
drop function if exists public.market_orders(uuid[]);

-- assets index (/asset): for every root location (a station, structure or
-- solar system that isn't itself one of our items), the number of item stacks
-- there, split by the character that owns each stack. Each asset is climbed up
-- its location_id chain through items we also own until the parent isn't ours;
-- that parent is the root.
create or replace function public.character_asset_location_summary()
returns table (location_id bigint, location_type text, character_id uuid, stacks bigint)
language sql
stable
as $$
  with recursive parent_of as (
    -- One best-known parent per item the caller can see: the live row if there is
    -- one, otherwise the most recent historical sighting. The walk climbs through
    -- this rather than the live-only character_asset view so it can bridge a
    -- container or ship that has momentarily dropped out of the current snapshot
    -- — e.g. one handed between the player's own characters, whose per-character
    -- extracts run at different times — and still roll its contents up to the
    -- enclosing structure instead of stranding them on the bare item id. RLS
    -- keeps character_asset_over_time scoped to the caller's own characters, so
    -- a container owned by someone else (a corpmate's) still can't be bridged.
    select distinct on (item_id) item_id, location_id, location_type
    from public.character_asset_over_time
    order by item_id, is_current desc, last_seen_at desc
  ),
  walk as (
    select
      a.item_id       as start_item,
      a.character_id  as character_id,
      a.location_id   as location_id,
      a.location_type as location_type,
      1               as depth
    from public.character_asset a
    union all
    select
      w.start_item,
      w.character_id,
      p.location_id,
      p.location_type,
      w.depth + 1
    from walk w
    join parent_of p on p.item_id = w.location_id
    where w.depth < 64
  )
  select
    w.location_id,
    w.location_type,
    w.character_id,
    count(*) as stacks
  from walk w
  where w.location_id is not null
    and not exists (select 1 from parent_of o where o.item_id = w.location_id)
  group by w.location_id, w.location_type, w.character_id;
$$;

-- per-location page (/asset/[locationId]): for each item sitting directly in
-- `parent`, the number of items nested inside it (the whole subtree, excluding
-- the item itself).
create or replace function public.character_asset_location_contents(parent bigint)
returns table (item_id bigint, contents bigint)
language sql
stable
as $$
  with recursive descend as (
    select a.item_id as root_child, a.item_id as node, 1 as depth
    from public.character_asset a
    where a.location_id = parent
    union all
    select d.root_child, c.item_id, d.depth + 1
    from descend d
    join public.character_asset c on c.location_id = d.node
    where d.depth < 64
  )
  select root_child as item_id, count(*) - 1 as contents
  from descend
  group by root_child;
$$;

grant execute on function public.character_asset_location_summary()        to authenticated;
grant execute on function public.character_asset_location_contents(bigint) to authenticated;

-- /api/character/assets IMPORTDATA endpoint: the player's raw asset rows (one
-- per item stack), with the owning character's name, as of `as_of`,
-- reconstructed from the SCD-2 history. A row counts when it had started by
-- `as_of` and was either still open then or is the current version (its state
-- extends forward past last_seen_at to now); a later version of an item always
-- starts after the prior one's last_seen_at, so at most one version per item
-- matches. Returns the whole result as a single json array so PostgREST's
-- max-rows cap never truncates it and the function (not the serverless route)
-- pages the table — what kept the endpoint under Vercel's timeout. Uses json
-- (not jsonb), which preserves the object key order below so the sheet's
-- columns come out in that exact order. Called with the service role over the
-- caller's own registration ids, so it takes them as a parameter rather than
-- leaning on RLS.
create or replace function public.character_asset_snapshot_at(character_ids uuid[], as_of timestamptz)
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
        'character_name',    r.name
      )
      order by a.item_id
    ),
    '[]'::json
  )
  from public.character_asset_over_time a
  join public.registration r on r.id = a.character_id
  where a.character_id = any(character_ids)
    and a.first_seen_at <= as_of
    and (a.last_seen_at >= as_of or a.is_current)
    and (not a.is_singleton or a.is_blueprint_copy);
$$;

grant execute on function public.character_asset_snapshot_at(uuid[], timestamptz) to service_role;

-- /api/character/jobs IMPORTDATA endpoint: the player's industry jobs across
-- all of their characters, with the owning character's name. Returns the whole
-- result as a single json array (json, not jsonb, so json_build_object's key
-- order is preserved for the sheet's columns; one scalar also sidesteps
-- PostgREST's max-rows cap). Called with the service role over the caller's own
-- registration ids, so it takes them as a parameter rather than leaning on RLS.
create or replace function public.character_industry_jobs(character_ids uuid[], include_delivered boolean default false)
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
  from public.character_industry_job j
  join public.registration r on r.id = j.character_id
  where j.character_id = any(character_ids)
    and (include_delivered or j.status not in ('delivered', 'cancelled', 'archived'));
$$;

grant execute on function public.character_industry_jobs(uuid[], boolean) to service_role;

-- /api/character/orders IMPORTDATA endpoint: the player's open market orders
-- across all of their characters, with the owning character's name. Returns the
-- whole result as a single json array (json, not jsonb, so json_build_object's
-- key order is preserved for the sheet's columns) and sidesteps PostgREST's
-- max-rows cap. The stored `is_buy` flag is exposed as `is_buy_order` to match
-- ESI's field name.
create or replace function public.character_orders(character_ids uuid[])
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
  from public.character_order o
  join public.registration r on r.id = o.character_id
  where o.character_id = any(character_ids);
$$;

grant execute on function public.character_orders(uuid[]) to service_role;

-- ── job bookkeeping ──────────────────────────────────────────────────────────
-- The scheduled jobs are renamed after the endpoint they extract, so carry the
-- unambiguous historical rows over to the new names (heartbeat feeds the "last
-- updated" labels, refresh_task the "last ✓" cells on /character/refresh). The
-- old `hourly` job covered several endpoints and maps to no single new name, so
-- its rows are left as history.
update public.heartbeat set job = 'character-assets'       where job = 'assets';
update public.heartbeat set job = 'character-orders'       where job = 'orders';
update public.heartbeat set job = 'corp-structures'        where job = 'structures';
update public.heartbeat set job = 'industry-systems'       where job = 'industry_index';
update public.heartbeat set job = 'character-affiliations' where job = 'daily';

update public.refresh_task set job = 'character-assets'       where job = 'assets';
update public.refresh_task set job = 'character-orders'       where job = 'orders';
update public.refresh_task set job = 'character-affiliations' where job = 'daily';
