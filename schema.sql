-- Canonical schema for edencom-link, in the default `public` schema (PostgREST
-- exposes it out of the box, so there is no "Exposed schemas" dashboard step).
--
-- This file is the single source of truth and a full reset: it DROPs the app's
-- objects and recreates them from scratch. Re-running it WIPES existing data in
-- these tables. Apply with `psql ... -f schema.sql` or paste into the Supabase
-- SQL editor. There is no separate migrations system — to change the schema,
-- edit this file and re-run it.
--
-- Naming: each extract table is named after the ESI endpoint that feeds it,
-- prefixed by owner scope — character_* (/characters/...), corp_*
-- (/corporations/...), universe_* (/universe/...) — and each is written by the
-- scheduled job of the same name (src/jobs/).

-- ── Reset ──────────────────────────────────────────────────────────────────
-- Nuke any leftover from the previous `hangar` schema, then drop the app's
-- objects in `public`. CASCADE clears dependent foreign keys and the asset
-- views. The pre-endpoint-naming object names are dropped too, so this reset
-- also works against a database that never took the rename migration.
drop schema if exists hangar cascade;

drop function if exists public.asset_location_summary()        cascade;
drop function if exists public.asset_location_contents(bigint) cascade;
drop function if exists public.asset_inventory_at(uuid[], timestamptz) cascade;
drop function if exists public.asset_snapshot_at(uuid[], timestamptz)  cascade;
drop function if exists public.industry_jobs(uuid[])                   cascade;
drop function if exists public.industry_jobs(uuid[], boolean)          cascade;
drop function if exists public.market_orders(uuid[])                   cascade;
drop function if exists public.character_asset_location_summary()        cascade;
drop function if exists public.character_asset_location_contents(bigint) cascade;
drop function if exists public.corp_asset_location_summary()             cascade;
drop function if exists public.corp_asset_location_contents(bigint)      cascade;
drop function if exists public.asset_ancestors(bigint)                   cascade;
drop function if exists public.character_asset_search(bigint[])          cascade;
drop function if exists public.corp_asset_search(bigint[])               cascade;
drop function if exists public.blueprint_search(bigint[], bigint[], bigint[], uuid[], bigint[], text, int, int, boolean, text, int) cascade;
drop function if exists public.character_asset_snapshot_at(uuid[], timestamptz) cascade;
drop function if exists public.character_industry_jobs(uuid[], boolean)             cascade;
drop function if exists public.character_industry_jobs(uuid[], boolean, timestamptz) cascade;
drop function if exists public.corp_industry_jobs(uuid[], boolean)                  cascade;
drop function if exists public.corp_industry_jobs(uuid[], boolean, timestamptz)     cascade;
drop function if exists public.character_orders(uuid[])                  cascade;
drop function if exists public.character_orders(uuid[], timestamptz)     cascade;
drop function if exists public.latest_heartbeats()                       cascade;
drop view  if exists public.asset                cascade;
drop table if exists public.asset_over_time      cascade;
drop table if exists public.wallet               cascade;
drop table if exists public.market_transaction   cascade;
drop table if exists public.market_order         cascade;
drop table if exists public.industry_job         cascade;
drop table if exists public.corp_market_transaction cascade;
drop table if exists public.eve_name             cascade;
drop table if exists public.character_corp       cascade;
drop table if exists public.structure            cascade;
drop view  if exists public.character_asset               cascade;
drop table if exists public.character_asset_over_time     cascade;
drop view  if exists public.character_blueprint            cascade;
drop table if exists public.character_blueprint_over_time  cascade;
drop table if exists public.character_wallet              cascade;
drop table if exists public.character_wallet_transaction  cascade;
drop view  if exists public.character_order                cascade;
drop table if exists public.character_order_over_time      cascade;
drop view  if exists public.character_industry_job              cascade;
drop table if exists public.character_industry_job_over_time    cascade;
drop table if exists public.character_affiliation         cascade;
drop table if exists public.character_directory   cascade;
drop table if exists public.industry_system_index cascade;
drop table if exists public.corporation          cascade;
drop table if exists public.alliance             cascade;
drop table if exists public.corp_structure_status cascade;
drop table if exists public.corp_structure_rig   cascade;
drop table if exists public.corp_structure       cascade;
drop table if exists public.corp_wallet_journal  cascade;
drop table if exists public.corp_wallet_transaction cascade;
-- Pre-existing gap: corp_asset_over_time/corp_asset and corp_industry_job
-- never had drop statements, so re-running this file against an
-- already-reset database failed on them.
drop view  if exists public.corp_asset                cascade;
drop table if exists public.corp_asset_over_time      cascade;
drop view  if exists public.corp_industry_job              cascade;
drop table if exists public.corp_industry_job_over_time    cascade;
drop view  if exists public.corp_blueprint            cascade;
drop table if exists public.corp_blueprint_over_time  cascade;
drop table if exists public.character_location        cascade;
drop view  if exists public.character_clone            cascade;
drop table if exists public.character_clone_over_time  cascade;
drop table if exists public.character_clone_state      cascade;
drop table if exists public.character_implant          cascade;
drop view  if exists public.character_skill            cascade;
drop table if exists public.character_skill_over_time  cascade;
drop view  if exists public.character_ship              cascade;
drop table if exists public.character_ship_over_time    cascade;
drop view  if exists public.character_fitting            cascade;
drop table if exists public.character_fitting_over_time  cascade;
drop table if exists public.character_fitting_share      cascade;
-- Pre-existing gap: character_mercenary_den never had a drop statement (added
-- via migration), so re-running this file failed on it. Now an SCD table +
-- current-snapshot view, with status/share siblings.
drop view  if exists public.character_mercenary_den            cascade;
drop table if exists public.character_mercenary_den_share               cascade;
drop table if exists public.character_mercenary_den_status              cascade;
drop table if exists public.character_mercenary_den_over_time  cascade;
drop table if exists public.mercenary_den_enemy_intel           cascade;
drop table if exists public.universe_name        cascade;
drop table if exists public.universe_structure   cascade;
drop table if exists public.invite_code          cascade;
drop table if exists public.watched_system       cascade;
drop table if exists public.user_settings        cascade;
drop table if exists public.refresh_task         cascade;
drop table if exists public.shared_asset_token   cascade;
drop table if exists public.heartbeat            cascade;
drop table if exists public.esi_etag             cascade;
drop table if exists public.innominate_throttle  cascade;
drop table if exists public.innominate_appraisal cascade;
drop table if exists public.esf_data             cascade;
drop table if exists public.sheet_csv            cascade;
drop table if exists public.impersonation_log    cascade;
drop table if exists public.token                cascade;
drop table if exists public.registration         cascade;

-- SDE mirror objects (see the SDE mirror section at the end of this file).
-- The mirror tables are minted dynamically at ingest time (sde_<stem>, one
-- per JSONL file in CCP's export), so sweep them by prefix instead of by name.
drop function if exists public.ensure_sde_mirror_table(text, text) cascade;
drop function if exists public.sde_refresh_views()                 cascade;
drop function if exists public.sde_search_type(text, int)          cascade;
drop function if exists public.sde_search_system(text, int)        cascade;
drop materialized view if exists public.sde_blueprint_product cascade;
drop view if exists public.sde_published_type cascade;
drop view if exists public.sde_kspace_system  cascade;
drop view if exists public.sde_station        cascade;
drop view if exists public.sde_planet         cascade;
drop view if exists public.sde_group          cascade;
drop view if exists public.sde_category       cascade;
drop view if exists public.sde_region         cascade;
do $$
declare t record;
begin
  for t in
    select tablename from pg_tables
    where schemaname = 'public' and tablename like 'sde\_%'
  loop
    execute format('drop table if exists public.%I cascade', t.tablename);
  end loop;
end $$;

-- ── Schema grants ──────────────────────────────────────────────────────────
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on functions to anon, authenticated, service_role;

-- ── registration ──────────────────────────────────────────────────────────
-- One row per linked EVE character (a user may link several).
create table public.registration (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  owner text not null,
  name text not null,
  character_id bigint,
  corporation_id bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The user's chosen "main" character. At most one registration per user is the
  -- main (the /character "Set as Main" control clears the others); used to label
  -- an account by a single name (e.g. who invited you on /account/invite). Kept
  -- last to match the add-column migration's column order.
  is_main boolean not null default false,
  unique (user_id, owner)
);
create index character_user_id_idx on public.registration (user_id);
create index character_corporation_id_idx on public.registration (corporation_id);

alter table public.registration enable row level security;
create policy "Users manage own characters"
  on public.registration
  for all
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

grant select, insert, update, delete on public.registration to authenticated;
grant all                            on public.registration to service_role;

-- ── token ─────────────────────────────────────────────────────────────────
-- EVE SSO OAuth tokens, one row per character (refreshed before each fetch).
--
-- The owner column is `registration_id`, holding registration(id) — it was
-- called character_id until the rename in docs/registration-id-rename.md, the
-- first step of that cleanup. It matters more here than elsewhere because
-- forEachCharacter (src/jobs/lib.js) reads this table to build the argument
-- object every extract job destructures, so the name propagates from here.
create table public.token (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  registration_id uuid not null references public.registration(id) on delete cascade,
  access_token text not null,
  refresh_token text not null,
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  scope text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (registration_id)
);
create index token_registration_id_idx on public.token (registration_id);
create index token_user_id_idx on public.token (user_id);

alter table public.token enable row level security;
create policy "Users manage own tokens"
  on public.token
  for all
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

grant select, insert, update, delete on public.token to authenticated;
grant all                            on public.token to service_role;

-- ── character_asset_over_time ─────────────────────────────────────────────
-- ESI /characters/{id}/assets/, written by the character-assets job. Assets as
-- a slowly changing dimension (SCD type 2): each row is a versioned snapshot of
-- one item's state. When the extract sees an item whose tracked attributes
-- (location, quantity, ...) differ from its current row, that row is closed
-- (is_current = false) and a new row inserted, so full history is retained.
-- valid_until on the open row is extended every run the item is seen
-- unchanged. The `character_asset` view below exposes just the live rows.
create table public.character_asset_over_time (
  id bigint generated always as identity primary key,
  item_id bigint not null,
  registration_id uuid not null references public.registration(id) on delete cascade,
  type_id bigint not null,
  location_id bigint,
  location_flag text,
  location_type text,
  quantity bigint,
  is_singleton boolean,
  is_blueprint_copy boolean,
  is_current boolean not null default true,
  valid_from timestamptz not null default now(),
  valid_until timestamptz not null default now(),
  -- Player-assigned name (ship/container custom name) for singleton items; null
  -- otherwise. Kept last to match the add-column migration's column order.
  name text
);
create index character_asset_over_time_registration_id_idx on public.character_asset_over_time (registration_id);
-- At most one live row per item; also the conflict target the extract relies on.
create unique index character_asset_over_time_current_item_idx on public.character_asset_over_time (item_id) where is_current;
-- Time-travel lookups walking an item's version history.
create index character_asset_over_time_item_id_idx on public.character_asset_over_time (item_id, valid_until desc);

alter table public.character_asset_over_time enable row level security;
create policy "Users read own assets"
  on public.character_asset_over_time
  for select
  to authenticated
  using (
    registration_id in (
      select id from public.registration where user_id = (select auth.uid())
    )
  );

-- Live snapshot of assets. security_invoker keeps the underlying RLS in force
-- for the querying (authenticated) role rather than running as the view owner.
create view public.character_asset with (security_invoker = on) as
  select * from public.character_asset_over_time where is_current;

grant select on public.character_asset_over_time to authenticated;
grant select on public.character_asset           to authenticated;
grant all    on public.character_asset_over_time to service_role;

-- ── character asset aggregation functions ─────────────────────────────────
-- Items nest (a module in a ship in a station), so the UI used to page every
-- live asset into Node and walk the location_id chains there — tens of
-- thousands of rows per request, which timed the pages out. These do the walk
-- in Postgres instead and return only the aggregate each page needs. Both are
-- SECURITY INVOKER (the default), so the character_asset view's RLS still
-- scopes every read to the caller's own characters. The depth caps guard
-- against cycles.

-- assets index (/asset): for every root location (a station, structure or
-- solar system that isn't itself one of our items), the number of item stacks
-- there, split by the character that owns each stack. Each asset is climbed up
-- its location_id chain through items we also own until the parent isn't ours;
-- that parent is the root.
create or replace function public.character_asset_location_summary()
returns table (location_id bigint, location_type text, registration_id uuid, stacks bigint, station_name text, system_id bigint)
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
    order by item_id, is_current desc, valid_until desc
  ),
  walk as (
    select
      a.item_id       as start_item,
      a.registration_id  as registration_id,
      a.location_id   as location_id,
      a.location_type as location_type,
      1               as depth
    from public.character_asset a
    union all
    select
      w.start_item,
      w.registration_id,
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
    w.registration_id,
    count(*) as stacks,
    st.name as station_name,
    st.system_id
  from walk w
  left join public.sde_station st on st.station_id = w.location_id
  where w.location_id is not null
    and not exists (select 1 from parent_of o where o.item_id = w.location_id)
  group by w.location_id, w.location_type, w.registration_id, st.name, st.system_id;
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

-- item search (/asset/search): every current item whose type_id is in
-- `type_ids`, with its root location and nested-item count. Seeded from just
-- the matched items (rather than every asset, like the two functions above),
-- so this stays cheap even though the caller can pass up to 100 type ids.
create or replace function public.character_asset_search(type_ids bigint[])
returns table (
  item_id bigint,
  registration_id uuid,
  type_id bigint,
  quantity bigint,
  is_singleton boolean,
  name text,
  location_flag text,
  root_location_id bigint,
  root_location_type text,
  contents bigint,
  type_name text,
  root_location_name text,
  system_id bigint,
  parent_id bigint,
  parent_type_id bigint,
  parent_name text
)
language sql
stable
as $$
  with recursive parent_of as (
    select distinct on (item_id) item_id, location_id, location_type
    from public.character_asset_over_time
    order by item_id, is_current desc, valid_until desc
  ),
  matched as (
    select a.item_id, a.registration_id, a.type_id, a.quantity, a.is_singleton, a.name,
           a.location_flag, a.location_id, a.location_type
    from public.character_asset a
    where a.type_id = any(type_ids)
  ),
  climb as (
    select m.item_id as start_item, m.location_id, m.location_type, 1 as depth
    from matched m
    union all
    select c.start_item, p.location_id, p.location_type, c.depth + 1
    from climb c
    join parent_of p on p.item_id = c.location_id
    where c.depth < 64
  ),
  roots as (
    select w.start_item, w.location_id as root_location_id, w.location_type as root_location_type
    from climb w
    where w.location_id is not null
      and not exists (select 1 from parent_of o where o.item_id = w.location_id)
  ),
  descend as (
    select m.item_id as ancestor, m.item_id as node, 1 as depth
    from matched m
    union all
    select d.ancestor, c.item_id, d.depth + 1
    from descend d
    join public.character_asset c on c.location_id = d.node
    where d.depth < 64
  ),
  contents as (
    select ancestor, count(*) - 1 as contents
    from descend
    group by ancestor
  )
  select
    m.item_id,
    m.registration_id,
    m.type_id,
    m.quantity,
    m.is_singleton,
    m.name,
    m.location_flag,
    r.root_location_id,
    r.root_location_type,
    coalesce(ct.contents, 0) as contents,
    t.name as type_name,
    st.name as root_location_name,
    st.system_id,
    m.location_id as parent_id,
    p.type_id as parent_type_id,
    p.name as parent_name
  from matched m
  join roots r on r.start_item = m.item_id
  left join contents ct on ct.ancestor = m.item_id
  left join public.sde_published_type t on t.type_id = m.type_id
  left join public.sde_station st on st.station_id = r.root_location_id
  left join public.character_asset p on p.item_id = m.location_id;
$$;

grant execute on function public.character_asset_location_summary()        to authenticated;
grant execute on function public.character_asset_location_contents(bigint) to authenticated;
grant execute on function public.character_asset_search(bigint[])          to authenticated;

-- /api/character/assets IMPORTDATA endpoint: the player's raw asset rows (one
-- per item stack), with the owning character's name, as of `as_of`,
-- reconstructed from the SCD-2 history. A row counts when it had started by
-- `as_of` and was either still open then or is the current version (its state
-- extends forward past valid_until to now); a later version of an item always
-- starts after the prior one's valid_until, so at most one version per item
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
  where a.registration_id = any(character_ids)
    and a.valid_from <= as_of
    and (a.is_current or a.valid_until >= as_of)
    and (not a.is_singleton or a.is_blueprint_copy);
$$;

grant execute on function public.character_asset_snapshot_at(uuid[], timestamptz) to service_role;

-- ── character_blueprint_over_time ─────────────────────────────────────────
-- ESI /characters/{id}/blueprints/, written by the character-blueprints job.
-- SCD Type 2 history of a character's blueprints, mirroring
-- character_asset_over_time: is_current=true rows form the current snapshot,
-- valid_until is bumped each run for unchanged blueprints, and a new row is
-- inserted when anything tracked changes (old row's is_current set false).
-- quantity is -1 for an original (BPO), -2 for a copy (BPC), or the stack size
-- for multiple BPOs stacked together; runs is -1 for a BPO (unlimited) or the
-- runs remaining on a BPC. ESI's blueprint payload has no location_type
-- (unlike assets), so that column isn't tracked here.
create table public.character_blueprint_over_time (
  id bigint generated always as identity primary key,
  item_id bigint not null,
  registration_id uuid not null references public.registration(id) on delete cascade,
  type_id bigint not null,
  location_id bigint,
  location_flag text,
  quantity bigint,
  material_efficiency smallint,
  time_efficiency smallint,
  runs integer,
  is_current boolean not null default true,
  valid_from timestamptz not null default now(),
  valid_until timestamptz not null default now()
);
create index character_blueprint_over_time_registration_id_idx on public.character_blueprint_over_time (registration_id);
-- At most one live row per item; also the conflict target the extract relies on.
create unique index character_blueprint_over_time_current_item_idx on public.character_blueprint_over_time (item_id) where is_current;
-- Time-travel lookups walking an item's version history.
create index character_blueprint_over_time_item_id_idx on public.character_blueprint_over_time (item_id, valid_until desc);

alter table public.character_blueprint_over_time enable row level security;
create policy "Users read own blueprints"
  on public.character_blueprint_over_time
  for select
  to authenticated
  using (
    registration_id in (
      select id from public.registration where user_id = (select auth.uid())
    )
  );

-- Live snapshot of blueprints. security_invoker keeps the underlying RLS in
-- force for the querying (authenticated) role rather than running as the view owner.
create view public.character_blueprint with (security_invoker = on) as
  select * from public.character_blueprint_over_time where is_current;

grant select on public.character_blueprint_over_time to authenticated;
grant select on public.character_blueprint           to authenticated;
grant all    on public.character_blueprint_over_time to service_role;

-- /api/character/blueprints IMPORTDATA endpoint: the player's current
-- blueprint rows across all of their characters, with the owning character's
-- name. Returns json (not jsonb) so json_build_object's key order is
-- preserved for the sheet's columns, and a single scalar sidesteps
-- PostgREST's max-rows cap. Live snapshot only (no time-travel `as_of`, unlike
-- character_asset_snapshot_at) — a blueprint's current research level and
-- location is what the sheet needs.
create or replace function public.character_blueprints(character_ids uuid[])
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
  where b.registration_id = any(character_ids);
$$;

grant execute on function public.character_blueprints(uuid[]) to service_role;

-- ── heartbeat ─────────────────────────────────────────────────────────────
-- One row per scheduled-job run. Workflows write a 'start' step (stamps
-- started_at) and an 'end' step (stamps ended_at), both keyed on the GitHub
-- Actions run so they land on the same row. run_url links back to that run.
-- character_id/corporation_id/user_id attribute a run to the entity a
-- per-character or per-corp job processed it for (null for whole-job/
-- account-wide runs, e.g. universe-names); owner_key folds those two
-- nullable columns into a single non-null discriminator so the start/end
-- upsert still pairs correctly per entity (see recordHeartbeat).
create table public.heartbeat (
  id uuid primary key default gen_random_uuid(),
  job text not null,
  run_id bigint,
  run_attempt integer,
  run_url text,
  registration_id uuid references public.registration(id) on delete cascade,
  corporation_id bigint,
  user_id uuid references auth.users(id) on delete cascade,
  owner_key text generated always as (coalesce(registration_id::text, '') || '|' || coalesce(corporation_id::text, '')) stored,
  -- Which execution path recorded the run: 'vercel' (queue consumer),
  -- 'vercel-cron' (direct cron routes), 'vercel-workflow' (workflow steps),
  -- 'github' (Actions). Null for local CLI runs and the per-character/per-corp
  -- loop rows, which don't know how they were invoked.
  source text,
  started_at timestamptz,
  ended_at timestamptz,
  -- How long the run took for that job/entity; null until ended_at lands.
  duration interval generated always as (ended_at - started_at) stored,
  ran_at timestamptz not null default now()
);
-- Pairs the start/end steps of a single run onto one row. Local runs (no run
-- id) fall back to plain inserts, and Postgres keeps null keys distinct.
create unique index heartbeat_run_idx on public.heartbeat (job, run_id, run_attempt, owner_key);
create index heartbeat_ran_at_idx on public.heartbeat (ran_at desc);
-- Lets the UI find a job's most recent completion with an index scan.
create index heartbeat_job_ended_at_idx on public.heartbeat (job, ended_at desc);
create index heartbeat_registration_id_idx on public.heartbeat (registration_id);
create index heartbeat_corporation_id_idx on public.heartbeat (corporation_id);
-- Lets the header's "Refreshed N minutes ago" indicator find a user's most
-- recent completed extract with an index scan on every page render.
create index heartbeat_user_id_ended_at_idx on public.heartbeat (user_id, ended_at desc);

alter table public.heartbeat enable row level security;
-- Whole-job/account-wide rows (user_id null) are visible to everyone signed
-- in, same as before this table carried any owner info. A per-character row
-- is visible to the owning user; a per-corp row to anyone with a character
-- in that corp — mirroring the corp_structure/corp_asset RLS convention.
create policy "Authenticated read heartbeat"
  on public.heartbeat
  for select
  to authenticated
  using (
    user_id is null
    or user_id = (select auth.uid())
    or corporation_id in (
      select corporation_id from public.registration
      where user_id = (select auth.uid()) and corporation_id is not null
    )
  );

grant select on public.heartbeat to authenticated;
grant all    on public.heartbeat to service_role;

-- ── esi_etag ────────────────────────────────────────────────────────────────
-- Last ETag seen per ESI conditional-request cache key, so the extract jobs can
-- send If-None-Match and skip re-processing an unchanged snapshot on a 304 (see
-- esiConditionalJson in src/esi.js and getEsiEtag/putEsiEtag in src/supabase.js).
-- cache_key is "<job>:<registration uuid>" for the per-character snapshot jobs
-- (character-orders / -wallet-transactions / -industry-jobs). Internal cron
-- bookkeeping only: RLS is on with no policy, so only the service role reaches it.
create table public.esi_etag (
  cache_key  text primary key,
  etag       text not null,
  updated_at timestamptz not null default now()
);

alter table public.esi_etag enable row level security;
grant all on public.esi_etag to service_role;

-- ── innominate_throttle / innominate_appraisal ──────────────────────────────
-- Global throttle for the innomin.at appraisal API (see src/innominate.ts). The
-- provider allows 200 requests/hour for the whole deployment, so appraisals are
-- funnelled through a Vercel queue (topic "innominate", consumer at
-- /api/queue/innominate) draining at most one request every 18 seconds across
-- ALL lambda instances. Separate instances don't share memory, so the throttle
-- timestamp and the pending/finished results live here. Internal service-role
-- bookkeeping only: RLS on with no policy, so only the service role (the queue
-- consumer and the MCP tool) reaches them.
create table public.innominate_throttle (
  id               boolean primary key default true check (id),
  last_request_at  timestamptz not null default 'epoch'
);
insert into public.innominate_throttle (id) values (true) on conflict (id) do nothing;

alter table public.innominate_throttle enable row level security;
grant all on public.innominate_throttle to service_role;

-- One row per distinct (market + sorted item list) request, keyed by request_key
-- (the same hash the in-process cache uses). The producer upserts a 'pending'
-- row and blocks polling it; the consumer flips it to 'done' (mapped Appraisal
-- in `result`) or 'error' ({ kind, message, retryAfterSeconds } in `error`). A
-- fresh 'done' row (< 5 min) doubles as the global price cache.
create table public.innominate_appraisal (
  request_key  text primary key,
  market       text not null,
  items        jsonb not null,
  status       text not null default 'pending' check (status in ('pending', 'done', 'error')),
  result       jsonb,
  error        jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index innominate_appraisal_updated_at_idx on public.innominate_appraisal (updated_at);

alter table public.innominate_appraisal enable row level security;
grant all on public.innominate_appraisal to service_role;

-- Atomic leaky bucket: advance last_request_at to now() only if at least
-- min_interval_seconds have elapsed, returning acquired=true; otherwise return
-- acquired=false with wait_seconds until the next slot. The guarded UPDATE is a
-- single atomic statement, so concurrent consumers can't both take the same slot.
create or replace function public.innominate_try_acquire(min_interval_seconds integer default 18)
returns table (acquired boolean, wait_seconds double precision)
language plpgsql
as $$
declare
  v_now timestamptz := now();
begin
  insert into public.innominate_throttle (id) values (true) on conflict (id) do nothing;

  update public.innominate_throttle
     set last_request_at = v_now
   where id = true
     and v_now - last_request_at >= make_interval(secs => min_interval_seconds);

  if found then
    return query select true, 0::double precision;
  else
    return query
      select false,
             greatest(
               extract(epoch from (make_interval(secs => min_interval_seconds) - (v_now - last_request_at))),
               0
             )::double precision
        from public.innominate_throttle
       where id = true;
  end if;
end;
$$;

grant execute on function public.innominate_try_acquire(integer) to service_role;

-- ── impersonation_log ──────────────────────────────────────────────────────
-- Chancellor-impersonation audit trail: one row per magic-link impersonation
-- session minted via /account/debug (see src/app/account/debug/impersonate.ts).
-- Internal-only, service-role bookkeeping — RLS is on with no policy, mirroring
-- esi_etag, so neither the impersonating Chancellor nor the impersonated user
-- can read it through the API.
create table public.impersonation_log (
  id uuid primary key default gen_random_uuid(),
  chancellor_user_id uuid not null references auth.users(id) on delete cascade,
  target_user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index impersonation_log_target_user_id_idx on public.impersonation_log (target_user_id);

alter table public.impersonation_log enable row level security;
grant all on public.impersonation_log to service_role;

-- The most recent completed heartbeat per job per owner (character, corp, or
-- whole-job), driving the freshness dots on /character/refresh. DISTINCT ON
-- over owner_key rather than the two nullable id columns so the account-wide
-- rows (both ids null) collapse to one row per job instead of being merged by
-- null-grouping quirks. Floored to the last 30 days to keep the sort bounded
-- as heartbeat grows — anything older is stale enough to read as "never".
-- SECURITY INVOKER (the default), so heartbeat's RLS scopes the rows to the
-- caller: their own characters, their corps, and the shared account-wide jobs.
create or replace function public.latest_heartbeats()
returns table (job text, registration_id uuid, corporation_id bigint, ended_at timestamptz)
language sql
stable
as $$
  select distinct on (h.job, h.owner_key)
    h.job, h.registration_id, h.corporation_id, h.ended_at
  from public.heartbeat h
  where h.ended_at is not null
    and h.ended_at > now() - interval '30 days'
  order by h.job, h.owner_key, h.ended_at desc;
$$;

grant execute on function public.latest_heartbeats() to authenticated;

-- ── character_wallet ──────────────────────────────────────────────────────
-- ESI /characters/{id}/wallet/, written by the character-wallet job. One
-- balance row appended per character per run.
create table public.character_wallet (
  id uuid primary key default gen_random_uuid(),
  registration_id uuid not null references public.registration(id) on delete cascade,
  balance numeric(20, 2) not null,
  recorded_at timestamptz not null default now()
);
create index character_wallet_registration_id_recorded_at_idx on public.character_wallet (registration_id, recorded_at desc);

alter table public.character_wallet enable row level security;
create policy "Users read own wallets"
  on public.character_wallet
  for select
  to authenticated
  using (
    registration_id in (
      select id from public.registration where user_id = (select auth.uid())
    )
  );

grant select on public.character_wallet to authenticated;
grant all    on public.character_wallet to service_role;

-- ── character_wallet_transaction ──────────────────────────────────────────
-- ESI /characters/{id}/wallet/transactions/, written by the
-- character-wallet-transactions job.
create table public.character_wallet_transaction (
  transaction_id bigint primary key,
  registration_id uuid not null references public.registration(id) on delete cascade,
  date timestamptz not null,
  type_id bigint not null,
  quantity bigint not null,
  unit_price numeric(20, 2) not null,
  is_buy boolean not null,
  is_personal boolean not null,
  client_id bigint not null,
  location_id bigint not null,
  journal_ref_id bigint not null,
  seen_at timestamptz not null default now()
);
create index character_wallet_transaction_registration_id_date_idx on public.character_wallet_transaction (registration_id, date desc);

alter table public.character_wallet_transaction enable row level security;
create policy "Users read own transactions"
  on public.character_wallet_transaction
  for select
  to authenticated
  using (
    registration_id in (
      select id from public.registration where user_id = (select auth.uid())
    )
  );

grant select on public.character_wallet_transaction to authenticated;
grant all    on public.character_wallet_transaction to service_role;

-- ── character_order_over_time ─────────────────────────────────────────────
-- ESI /characters/{id}/orders/, written by the character-orders job. The
-- character's open market orders as a slowly changing dimension (SCD type 2),
-- mirroring character_asset_over_time: each row is a versioned snapshot of one
-- order's mutable state (price, remaining volume, escrow, ...). When the
-- extract sees an order whose tracked attributes differ from its current row,
-- that row is closed (is_current = false) and a new one inserted, so the order's
-- fill/price trajectory is retained. valid_until on the open row is extended
-- every run the order is seen unchanged. An order that drops out of the
-- snapshot (filled, expired or cancelled) has its open row closed, so the
-- character_order view of is_current rows holds exactly the still-open orders
-- — the same live set the old plain table exposed. is_buy is false for sell
-- orders (ESI omits is_buy_order on those); escrow/min_volume are
-- buy-order-only, hence nullable.
create table public.character_order_over_time (
  id bigint generated always as identity primary key,
  order_id bigint not null,
  registration_id uuid not null references public.registration(id) on delete cascade,
  type_id bigint not null,
  region_id bigint not null,
  location_id bigint not null,
  range text not null,
  is_buy boolean not null,
  is_corporation boolean not null,
  price numeric(20, 2) not null,
  volume_total bigint not null,
  volume_remain bigint not null,
  min_volume bigint,
  escrow numeric(20, 2),
  duration integer not null,
  issued timestamptz not null,
  is_current boolean not null default true,
  valid_from timestamptz not null default now(),
  valid_until timestamptz not null default now()
);
create index character_order_over_time_registration_id_idx on public.character_order_over_time (registration_id);
-- At most one live row per order; also the conflict target the reconcile relies on.
create unique index character_order_over_time_current_order_idx on public.character_order_over_time (order_id) where is_current;
-- Time-travel lookups walking an order's version history.
create index character_order_over_time_order_id_idx on public.character_order_over_time (order_id, valid_until desc);

alter table public.character_order_over_time enable row level security;
create policy "Users read own orders"
  on public.character_order_over_time
  for select
  to authenticated
  using (
    registration_id in (
      select id from public.registration where user_id = (select auth.uid())
    )
  );

-- Live snapshot of open orders. security_invoker keeps the underlying RLS in
-- force for the querying (authenticated) role rather than running as the view owner.
create view public.character_order with (security_invoker = on) as
  select * from public.character_order_over_time where is_current;

grant select on public.character_order_over_time to authenticated;
grant select on public.character_order           to authenticated;
grant all    on public.character_order_over_time to service_role;

-- /api/character/orders IMPORTDATA endpoint: the player's open market orders
-- across all of their characters, with the owning character's name, as of an
-- optional `as_of` timestamp (default now). Reconstructed from the SCD-2 history
-- exactly like character_asset_snapshot_at: the version of each order valid at
-- `as_of` is the one that had started by then and was either still open then
-- (valid_until >= as_of) or is the current version (its state extends forward to
-- now) — and versions of one order never overlap, so at most one matches. At the
-- default now() this returns precisely the still-open orders (the is_current
-- set), matching the character_order view. Returns the whole result as a single
-- json array (json, not jsonb, so json_build_object's key order is preserved for
-- the sheet's columns) and sidesteps PostgREST's max-rows cap. The stored
-- `is_buy` flag is exposed as `is_buy_order` to match ESI's field name.
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
  where o.registration_id = any(character_ids)
    and o.valid_from <= as_of
    and (o.is_current or o.valid_until >= as_of);
$$;

grant execute on function public.character_orders(uuid[], timestamptz) to service_role;

-- ── character_industry_job_over_time ──────────────────────────────────────
-- ESI /characters/{id}/industry/jobs/ (include_completed), written by the
-- character-industry-jobs job. SCD Type 2 history of a character's industry
-- jobs, mirroring character_asset_over_time: each row is a versioned snapshot
-- of one job keyed on job_id. As a job advances (active → paused → delivered)
-- its tracked state (status, pause/completed dates, completed_character_id,
-- successful_runs) changes, closing the old row and opening a new one, so the
-- transition history is retained; valid_until is bumped each run a job is
-- seen unchanged. Unlike the orders/assets reconcile, a job that drops out of
-- the ESI listing (a delivered job aged past include_completed's window) is
-- NOT closed — its terminal row stays is_current so the character_industry_job
-- view keeps every job the endpoint ever reported, matching the old plain
-- table (which never swept completed jobs).
create table public.character_industry_job_over_time (
  id bigint generated always as identity primary key,
  job_id bigint not null,
  registration_id uuid not null references public.registration(id) on delete cascade,
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
  is_current boolean not null default true,
  valid_from timestamptz not null default now(),
  valid_until timestamptz not null default now()
);
create index character_industry_job_over_time_registration_id_idx on public.character_industry_job_over_time (registration_id);
-- At most one live row per job; also the conflict target the reconcile relies on.
create unique index character_industry_job_over_time_current_job_idx on public.character_industry_job_over_time (job_id) where is_current;
-- Time-travel lookups walking a job's version history.
create index character_industry_job_over_time_job_id_idx on public.character_industry_job_over_time (job_id, valid_until desc);

alter table public.character_industry_job_over_time enable row level security;
create policy "Users read own industry jobs"
  on public.character_industry_job_over_time
  for select
  to authenticated
  using (
    registration_id in (
      select id from public.registration where user_id = (select auth.uid())
    )
  );

-- Live snapshot of industry jobs. security_invoker keeps the underlying RLS in
-- force for the querying (authenticated) role rather than running as the view owner.
create view public.character_industry_job with (security_invoker = on) as
  select * from public.character_industry_job_over_time where is_current;

grant select on public.character_industry_job_over_time to authenticated;
grant select on public.character_industry_job           to authenticated;
grant all    on public.character_industry_job_over_time to service_role;

-- /api/character/jobs IMPORTDATA endpoint: the player's industry jobs across
-- all of their characters, with the owning character's name. Returns the whole
-- result as a single json array (json, not jsonb, so json_build_object's key
-- order is preserved for the sheet's columns; one scalar also sidesteps
-- PostgREST's max-rows cap). Called with the service role over the caller's own
-- registration ids, so it takes them as a parameter rather than leaning on RLS.
-- `as_of` (default now) time-travels through the SCD-2 history like
-- character_asset_snapshot_at: the version of each job valid then is the one
-- that had started by `as_of` and was either still open then or is the current
-- version. The include_delivered filter is applied to that version's status, so
-- a job that is delivered now but was active at `as_of` shows as active. At the
-- default now() this returns the is_current set, matching the
-- character_industry_job view.
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
  where j.registration_id = any(character_ids)
    and j.valid_from <= as_of
    and (j.is_current or j.valid_until >= as_of)
    and (include_delivered or j.status not in ('delivered', 'cancelled', 'archived'));
$$;

grant execute on function public.character_industry_jobs(uuid[], boolean, timestamptz) to service_role;

-- ── character_location ────────────────────────────────────────────────────
-- ESI /characters/{id}/location/, written by the character-location job. Live
-- current-state data — ESI only ever reports "where is the character right
-- now" — so this is a single upserted row per character, not a history table.
create table public.character_location (
  registration_id uuid primary key references public.registration(id) on delete cascade,
  solar_system_id bigint not null,
  station_id bigint,
  structure_id bigint,
  recorded_at timestamptz not null default now()
);

alter table public.character_location enable row level security;
create policy "Users read own location"
  on public.character_location
  for select
  to authenticated
  using (
    registration_id in (
      select id from public.registration where user_id = (select auth.uid())
    )
  );

grant select on public.character_location to authenticated;
grant all    on public.character_location to service_role;

-- ── character_clone_over_time ─────────────────────────────────────────────
-- ESI /characters/{id}/clones/, written by the character-clones job: the
-- character's home clone plus every jump clone, each with the implants
-- installed in it. Jump clones rarely change, so this mirrors the
-- character_asset_over_time / character_blueprint_over_time SCD Type 2
-- pattern, keyed per clone (jump_clone_id, or is_home for the home clone)
-- rather than per item.
create table public.character_clone_over_time (
  id bigint generated always as identity primary key,
  registration_id uuid not null references public.registration(id) on delete cascade,
  jump_clone_id bigint,
  is_home boolean not null default false,
  location_id bigint not null,
  location_type text,
  name text,
  implants jsonb not null default '[]'::jsonb,
  is_current boolean not null default true,
  valid_from timestamptz not null default now(),
  valid_until timestamptz not null default now(),
  -- Solar system the clone's station/structure sits in, resolved at extract
  -- time (null until resolvable). Kept last so a fresh reset matches the
  -- column order of migrated databases (the character_clone view is select *).
  system_id bigint
);
create index character_clone_over_time_registration_id_idx on public.character_clone_over_time (registration_id);
create unique index character_clone_over_time_current_jump_idx
  on public.character_clone_over_time (registration_id, jump_clone_id) where is_current and not is_home;
create unique index character_clone_over_time_current_home_idx
  on public.character_clone_over_time (registration_id) where is_current and is_home;

alter table public.character_clone_over_time enable row level security;
create policy "Users read own clones"
  on public.character_clone_over_time
  for select
  to authenticated
  using (
    registration_id in (
      select id from public.registration where user_id = (select auth.uid())
    )
  );

create view public.character_clone with (security_invoker = on) as
  select * from public.character_clone_over_time where is_current;

grant select on public.character_clone_over_time to authenticated;
grant select on public.character_clone           to authenticated;
grant all    on public.character_clone_over_time to service_role;

-- ── character_implant ─────────────────────────────────────────────────────
-- ESI /characters/{id}/implants/, written by the character-implants job: the
-- implants currently plugged into whichever clone body the character
-- presently occupies. Live current-state data, like character_location — a
-- single upserted row per character rather than a history table.
create table public.character_implant (
  registration_id uuid primary key references public.registration(id) on delete cascade,
  type_ids bigint[] not null default '{}',
  recorded_at timestamptz not null default now()
);

alter table public.character_implant enable row level security;
create policy "Users read own implants"
  on public.character_implant
  for select
  to authenticated
  using (
    registration_id in (
      select id from public.registration where user_id = (select auth.uid())
    )
  );

grant select on public.character_implant to authenticated;
grant all    on public.character_implant to service_role;

-- ── character_skill_over_time (SCD type 2) ────────────────────────────────
-- ESI /characters/{id}/skills/, written by the character-skills job (also
-- folded into character-status): one row per trained skill, carrying its active
-- and trained level. A skill's level only ever climbs (and a skill never leaves
-- a character), but that history is worth keeping — when a training completes,
-- the open row is closed and a new one opened, mirroring the
-- character_asset_over_time / character_ship_over_time SCD Type 2 pattern: one
-- open (is_current) row per (character, skill), valid_until bumped when the
-- level is unchanged, a new version opened on a level change. Because a skill is
-- never unlearned, a row is never closed for vanishing — only superseded.
-- Drives the industry job-slot counts on the character list (the two Mass
-- Production / Laboratory Operation / Mass Reactions skills per family).
create table public.character_skill_over_time (
  id bigint generated always as identity primary key,
  registration_id uuid not null references public.registration(id) on delete cascade,
  skill_id bigint not null,
  active_skill_level smallint not null default 0,
  trained_skill_level smallint not null default 0,
  is_current boolean not null default true,
  valid_from timestamptz not null default now(),
  valid_until timestamptz not null default now()
);
create index character_skill_over_time_registration_id_idx on public.character_skill_over_time (registration_id);
create unique index character_skill_over_time_current_idx
  on public.character_skill_over_time (registration_id, skill_id) where is_current;

alter table public.character_skill_over_time enable row level security;
create policy "Users read own skills"
  on public.character_skill_over_time
  for select
  to authenticated
  using (
    registration_id in (
      select id from public.registration where user_id = (select auth.uid())
    )
  );

create view public.character_skill with (security_invoker = on) as
  select * from public.character_skill_over_time where is_current;

grant select on public.character_skill_over_time to authenticated;
grant select on public.character_skill           to authenticated;
grant all    on public.character_skill_over_time to service_role;

-- ── character_ship_over_time ──────────────────────────────────────────────
-- ESI /characters/{id}/ship/, written by the character-ship job: the ship the
-- character is currently in, docked or not — a character's asset row for
-- that ship reports its location as the station it last docked at,
-- physically indistinguishable from any other ship parked there. Used to tag
-- the character's current ship in a station's asset listing. A character can
-- only be in one ship at a time, but which ship changes over a character's
-- life, so this mirrors the character_asset_over_time /
-- character_clone_over_time SCD Type 2 pattern rather than being a plain live
-- upsert. A row's identity is ship_item_id alone — stable for as long as the
-- ship stays assembled (repackaging destroys it) — so switching ships closes
-- the open row and opens a new one, while renaming the current ship just
-- updates the open row's ship_name in place.
create table public.character_ship_over_time (
  id bigint generated always as identity primary key,
  registration_id uuid not null references public.registration(id) on delete cascade,
  ship_item_id bigint not null,
  ship_type_id bigint not null,
  ship_name text,
  is_current boolean not null default true,
  valid_from timestamptz not null default now(),
  valid_until timestamptz not null default now()
);
create index character_ship_over_time_registration_id_idx on public.character_ship_over_time (registration_id);
create unique index character_ship_over_time_current_idx
  on public.character_ship_over_time (registration_id) where is_current;

alter table public.character_ship_over_time enable row level security;
create policy "Users read own ship"
  on public.character_ship_over_time
  for select
  to authenticated
  using (
    registration_id in (
      select id from public.registration where user_id = (select auth.uid())
    )
  );

create view public.character_ship with (security_invoker = on) as
  select * from public.character_ship_over_time where is_current;

grant select on public.character_ship_over_time to authenticated;
grant select on public.character_ship           to authenticated;
grant all    on public.character_ship_over_time to service_role;

-- ── character_fitting_over_time (SCD type 2) ──────────────────────────────
-- ESI /characters/{id}/fittings/, written by the character-fittings job: the
-- ship fittings a character has saved in the game client. ESI returns the whole
-- library in one response, reconciled here like every other full-snapshot
-- endpoint — one open (is_current) row per (character, fitting), valid_until
-- bumped when the fit is unchanged, a new version opened when it's edited (a
-- fit is edited in place in the client: same fitting_id, different modules), and
-- the open row closed when the fit is deleted. The character_fitting view is the
-- live snapshot.
--
-- owner_scope is 'character' for every row today. ESI exposes only a character's
-- *personal* fittings — there is no corporation or alliance fittings endpoint,
-- and the response carries no folder discriminator, so a doctrine fit copied to
-- personal is indistinguishable from any other (see docs/fittings.md). The
-- column exists so that if CCP ever ships one, ingesting it writes a different
-- value into this table rather than needing a new one.
--
-- items is the fit's module list as jsonb ([{ type_id, flag, quantity }],
-- normalized and slot-sorted by the job so an unchanged fit compares equal): a
-- small blob that is always read whole and never joined against, exactly like
-- character_clone_over_time.implants. Module *names* are deliberately not stored
-- — the page resolves them through the sde_* loaders at render time rather than
-- keeping a stale copy of the SDE mirror.
--
-- The owner column is `registration_id`, not `character_id`: it holds
-- registration(id), a uuid. The sibling character_* extract tables call the
-- same thing character_id, which is a long-standing misnomer (see the id
-- naming note in CLAUDE.md) — these two fitting tables are named correctly so
-- `character_id` can keep meaning the EVE numeric id everywhere it appears,
-- including the /fitting/[characterId]/[fittingId] route.
create table public.character_fitting_over_time (
  id bigint generated always as identity primary key,
  registration_id uuid not null references public.registration(id) on delete cascade,
  owner_scope text not null default 'character',
  fitting_id bigint not null,
  name text,
  description text,
  ship_type_id bigint not null,
  items jsonb not null default '[]'::jsonb,
  is_current boolean not null default true,
  valid_from timestamptz not null default now(),
  valid_until timestamptz not null default now()
);
create index character_fitting_over_time_registration_id_idx
  on public.character_fitting_over_time (registration_id);
-- At most one live row per fit; also the collision guard the reconcile relies on.
create unique index character_fitting_over_time_current_idx
  on public.character_fitting_over_time (registration_id, fitting_id) where is_current;

alter table public.character_fitting_over_time enable row level security;
create policy "Users read own fittings"
  on public.character_fitting_over_time
  for select
  to authenticated
  using (
    registration_id in (
      select id from public.registration where user_id = (select auth.uid())
    )
  );

create view public.character_fitting with (security_invoker = on) as
  select * from public.character_fitting_over_time where is_current;

grant select on public.character_fitting_over_time to authenticated;
grant select on public.character_fitting           to authenticated;
grant all    on public.character_fitting_over_time to service_role;

-- ── character_fitting_share ───────────────────────────────────────────────
-- Shares for one saved fitting, at one of three levels, all widening read
-- access on character_fitting_over_time itself (see
-- fitting_shared_with_caller() and the policies after character_directory
-- below, which they depend on): 'corporation'/'alliance' to whoever currently
-- shares that corp/alliance with the owner — resolved live off the
-- world-readable character_directory at read time, the same "not frozen at
-- share time" philosophy the mercenary-den alliance sharing uses — and
-- 'public' to any signed-in user. No level carries a secret; there is no
-- anonymous no-login view. Every level points at the fit itself, never a copy
-- — an edit in the client is visible through any outstanding share, and
-- there's nothing to keep in sync.
--
-- No uniqueness on (registration_id, fitting_id): a player can hold one share
-- per level for the same fit at once, each independently revocable.
--
-- (registration_id, fitting_id) rather than character_fitting_over_time's own
-- surrogate `id`: that id is an SCD *version* stamp and changes every time the
-- fit is edited in the client, so a share pinned to it would silently break on
-- the next edit. (registration_id, fitting_id) is the fit's durable identity.
-- The /fitting/[characterId]/[fittingId] route addresses the same fit by the
-- owner's EVE character id instead, translated to this registration uuid at
-- the route boundary (src/app/fitting/resolveCharacter.ts).
create table public.character_fitting_share (
  id uuid primary key default gen_random_uuid(),
  registration_id uuid not null references public.registration(id) on delete cascade,
  fitting_id bigint not null,
  level text not null check (level in ('corporation', 'alliance', 'public')),
  -- Placeholder for a future anonymous-share-link design (a shared_asset_token
  -- style secret). Nothing writes or reads it today — an earlier draft minted
  -- one per public share, and the capability was pulled to be rethought.
  token text,
  created_at timestamptz not null default now()
);
create index character_fitting_share_fitting_idx on public.character_fitting_share (registration_id, fitting_id);

alter table public.character_fitting_share enable row level security;

-- Per-command owner policies, the character_mercenary_den_share layout —
-- deliberately not one FOR ALL policy, so what each command allows is
-- explicit. Only SELECT is ever widened beyond the owner (the audience policy
-- after character_directory below); INSERT and DELETE stay owner-only, so a
-- share can never be created or removed on behalf of a registration the
-- caller does not own. There is no UPDATE path at all (no policy, no
-- grant): a share row is immutable, toggled into and out of existence.

-- Owners always read their own share rows (drives the share toggles' checked
-- state), even for a level whose audience they've since left. Permissive:
-- OR'd with the audience policy below.
create policy "Users read own fitting shares"
  on public.character_fitting_share
  for select
  to authenticated
  using (
    registration_id in (select id from public.registration where user_id = (select auth.uid()))
  );

create policy "Users create own fitting shares"
  on public.character_fitting_share
  for insert
  to authenticated
  with check (
    registration_id in (select id from public.registration where user_id = (select auth.uid()))
  );

create policy "Users remove own fitting shares"
  on public.character_fitting_share
  for delete
  to authenticated
  using (
    registration_id in (select id from public.registration where user_id = (select auth.uid()))
  );

grant select, insert, delete on public.character_fitting_share to authenticated;
grant all                    on public.character_fitting_share to service_role;

-- ── character_mercenary_den (SCD type 2) ──────────────────────────────────
-- A character's deployed Mercenary Dens, from the compatibility-date ESI
-- endpoints /characters/{id}/structures/mercenary-dens (+ per-den detail). Only
-- the den's stable identity/config lives here — which character owns it, where
-- it sits, and its skyhook. The volatile observed state (development, anarchy,
-- infomorphs, running state, reinforcement timer) lives in the append-only
-- character_mercenary_den_status table below, so its constant drift doesn't churn a row
-- here. SCD-2 like character_asset_over_time: one open (is_current) row per den,
-- valid_until bumped when the config is unchanged, a new row opened (and the old
-- one closed) when the config changes, and the open row closed when the den is no
-- longer listed (unanchored/transferred). The character_mercenary_den view is the
-- live snapshot.
create table public.character_mercenary_den_over_time (
  id bigint generated always as identity primary key,
  registration_id uuid not null references public.registration(id) on delete cascade,
  den_id bigint not null,
  planet_id bigint not null,
  type_id bigint,
  skyhook_id bigint,
  skyhook_corporation_id bigint,
  is_current boolean not null default true,
  valid_from timestamptz not null default now(),
  valid_until timestamptz not null default now()
);
create index character_mercenary_den_over_time_registration_id_idx
  on public.character_mercenary_den_over_time (registration_id);
-- At most one live row per den; also the conflict target the extract relies on.
create unique index character_mercenary_den_over_time_current_idx
  on public.character_mercenary_den_over_time (registration_id, den_id) where is_current;
-- Time-travel lookups walking a den's version history.
create index character_mercenary_den_over_time_den_idx
  on public.character_mercenary_den_over_time (registration_id, den_id, valid_until desc);

alter table public.character_mercenary_den_over_time enable row level security;
-- Base policy: a user reads their own characters' dens. The sharing policy that
-- widens this to corp/alliance mates is added after the visibility helpers below.
create policy "Users read own mercenary dens"
  on public.character_mercenary_den_over_time
  for select
  to authenticated
  using (
    registration_id in (
      select id from public.registration where user_id = (select auth.uid())
    )
  );

-- ── character_mercenary_den_status ───────────────────────────────────────────────────
-- Append-only observation history for each den's volatile state. Every extract
-- run inserts one row per den it sees, rather than mutating the den row — these
-- values (development/anarchy evolution, stored infomorphs, running state, the
-- reinforcement timer) change constantly. Identified by the logical den
-- (registration_id, den_id); registration_id cascades from registration (the den table
-- is SCD, so there's no single den row to FK against).
create table public.character_mercenary_den_status (
  id bigint generated always as identity primary key,
  registration_id uuid not null references public.registration(id) on delete cascade,
  den_id bigint not null,
  state text,
  development_level text,
  development_amount bigint,
  anarchy_level text,
  anarchy_amount bigint,
  infomorphs bigint,
  reinforcement_end timestamptz,
  observed_at timestamptz not null default now()
);
create index character_mercenary_den_status_den_idx
  on public.character_mercenary_den_status (registration_id, den_id, observed_at desc);

alter table public.character_mercenary_den_status enable row level security;
-- A status row is readable exactly when its den is: the subquery over the SCD den
-- table inherits its own + corp-sharing policies (any version of the den), so
-- visibility is defined in one place and mirrored here.
create policy "Read status for visible mercenary dens"
  on public.character_mercenary_den_status
  for select
  to authenticated
  using (
    exists (
      select 1 from public.character_mercenary_den_over_time d
      where d.registration_id = character_mercenary_den_status.registration_id
        and d.den_id = character_mercenary_den_status.den_id
    )
  );

grant select on public.character_mercenary_den_status to authenticated;
grant all    on public.character_mercenary_den_status to service_role;

-- Live snapshot of dens, each enriched with its most recent observed status
-- (development/anarchy, infomorphs, running state, reinforcement timer) from
-- character_mercenary_den_status — null if the den has never been observed.
-- security_invoker keeps the underlying RLS in force for the querying
-- (authenticated) role rather than running as the view owner.
create view public.character_mercenary_den with (security_invoker = on) as
  select
    d.*,
    s.state,
    s.development_level,
    s.development_amount,
    s.anarchy_level,
    s.anarchy_amount,
    s.infomorphs,
    s.reinforcement_end,
    s.observed_at as status_observed_at
  from public.character_mercenary_den_over_time d
  left join lateral (
    select state, development_level, development_amount, anarchy_level, anarchy_amount,
           infomorphs, reinforcement_end, observed_at
    from public.character_mercenary_den_status s
    where s.registration_id = d.registration_id and s.den_id = d.den_id
    order by s.observed_at desc
    limit 1
  ) s on true
  where d.is_current;

grant select on public.character_mercenary_den_over_time to authenticated;
grant select on public.character_mercenary_den           to authenticated;
grant all    on public.character_mercenary_den_over_time to service_role;

-- ── character_mercenary_den_share ────────────────────────────────────────────
-- Per-character sharing preference: which alliances a character's owner has
-- opted to share their Mercenary Den data with. One row = "this character's
-- owner shares with this alliance." Originally one row per den per chosen
-- *corporation*, but the UI has always treated it as all-or-nothing ("share ALL
-- my dens with X"), so it collapsed to one row per (character, audience) — a
-- plain preference, not tied to any particular den — and the audience then
-- widened from corporation to alliance, because everyone who wanted sharing
-- wanted it coalition-wide and picking corps meant either ticking every corp in
-- the alliance or leaving fleetmates unable to see dens they were expected to
-- defend. That one preference also gates mercenary_den_enemy_intel (below): a
-- user's reported sightings are visible to a viewer exactly when that user's own
-- dens are.
--
-- character_id is a registration uuid (the grantor character), not an EVE
-- character id — the name predates the sharing layer and is kept to avoid
-- churning a table that already exists in production.
create table public.character_mercenary_den_share (
  character_id uuid not null references public.registration(id) on delete cascade,
  alliance_id bigint not null,
  created_at timestamptz not null default now(),
  primary key (character_id, alliance_id)
);
create index character_mercenary_den_share_alliance_id_idx
  on public.character_mercenary_den_share (alliance_id);

alter table public.character_mercenary_den_share enable row level security;

-- ── Sharing audience helpers ─────────────────────────────────────────────────
-- Plain stable SQL functions on INVOKER rights — deliberately NOT SECURITY
-- DEFINER. They read only what the caller may already read: their own
-- registrations (registration RLS exposes exactly those), the world-readable
-- corporation table, and share rows the policies below already expose. A share
-- row naming its own audience, plus owner identity coming from the
-- world-readable character_directory rather than public.registration, is what
-- removed the need for the definer bridges this sharing layer used to carry;
-- see docs/sharing-layer/design.md ("identity split"). They exist to keep the
-- policies readable, not to widen access. Defined before the policies that call
-- them, since a policy expression is parsed and validated at creation time.

-- The alliances the caller has a character in — the audiences they can share
-- with, and the ones the /mercenary-dens picker offers.
create or replace function public.my_alliance_ids()
returns setof bigint
language sql
stable
as $$
  select c.alliance_id
  from public.registration r
  join public.corporation c on c.corporation_id = r.corporation_id
  where r.user_id = (select auth.uid()) and c.alliance_id is not null;
$$;

-- The corporations the caller has a character in — the corp-level counterpart,
-- used by the fitting-share policies (after character_directory below).
create or replace function public.my_corporation_ids()
returns setof bigint
language sql
stable
as $$
  select r.corporation_id
  from public.registration r
  where r.user_id = (select auth.uid()) and r.corporation_id is not null;
$$;

-- True when the given registration shares its Mercenary Den data with an
-- alliance the caller has a character in. The single definition of the
-- audience — the den policy and the enemy-intel policy both go through it, so
-- they can't drift apart.
create or replace function public.mercenary_den_shared_with_caller(reg_id uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.character_mercenary_den_share sh
    where sh.character_id = reg_id
      and sh.alliance_id in (select public.my_alliance_ids())
  );
$$;

grant execute on function public.my_alliance_ids() to authenticated;
grant execute on function public.my_corporation_ids() to authenticated;
grant execute on function public.mercenary_den_shared_with_caller(uuid) to authenticated;

-- Members read the share rows aimed at their alliances. This is also what keeps
-- the den/intel policies working: mercenary_den_shared_with_caller runs as the
-- querying user, and the only rows it needs are exactly the ones this policy
-- exposes.
create policy "Alliance members read shares to their alliances"
  on public.character_mercenary_den_share
  for select
  to authenticated
  using (alliance_id in (select public.my_alliance_ids()));

-- Owners always read their own share rows (drives the /mercenary-dens picker's
-- checked state), even if the sharing character has since left that alliance —
-- without this, such a stale share would turn invisible to the very user who
-- created it. Permissive: OR'd with the alliance policy above.
create policy "Users read own den shares"
  on public.character_mercenary_den_share
  for select
  to authenticated
  using (
    character_id in (select id from public.registration where user_id = (select auth.uid()))
  );

-- Writes are the caller's own registrations only. They used to be service-role
-- only (the picker went through the service client); the audience is now
-- something the caller can be checked against directly, so plain RLS covers it.
create policy "Users create own den shares"
  on public.character_mercenary_den_share
  for insert
  to authenticated
  with check (
    character_id in (select id from public.registration where user_id = (select auth.uid()))
  );

create policy "Users remove own den shares"
  on public.character_mercenary_den_share
  for delete
  to authenticated
  using (
    character_id in (select id from public.registration where user_id = (select auth.uid()))
  );

grant select, insert, delete on public.character_mercenary_den_share to authenticated;
grant all                    on public.character_mercenary_den_share to service_role;

-- Alliance-sharing policy: a den is visible to the caller when its owner shares
-- with an alliance the caller has a character in. Additive/permissive: OR'd with
-- "Users read own mercenary dens" above, which stays as the owner's own path
-- independent of any share row.
create policy "Alliance members read shared mercenary dens"
  on public.character_mercenary_den_over_time
  for select
  to authenticated
  using (public.mercenary_den_shared_with_caller(registration_id));

-- ── mercenary_den_enemy_intel ────────────────────────────────────────────────────
-- Hand-submitted intel on enemy-owned Mercenary Dens seen reinforced. ESI has no
-- feed for another corp's dens, so this is a shared corkboard: any authenticated
-- user can post a sighting (system/planet, the enemy owner, and when its
-- reinforcement timer ends), mirroring the hand-maintained intel in data.ts but
-- user-editable at runtime instead of requiring a code change. Rendered as its
-- own table below the Temperate planets table on /mercenary-dens, not merged
-- into it, since an enemy den can be on any planet, not just the tracked
-- temperate ones. Visibility (below) follows real dens exactly — the same
-- character_mercenary_den_share rows, so a user's sightings reach whoever their
-- dens do — rather than being a separate opt-in.
create table public.mercenary_den_enemy_intel (
  id bigint generated always as identity primary key,
  system text not null,
  planet text not null,
  owner text,
  alliance text,
  reinforcement_end timestamptz,
  notes text,
  reported_by text not null,
  -- The reporting character. Ownership hangs off this rather than off
  -- created_by, so the same character_directory join that gates real dens can
  -- gate intel: an auth.users id can't be resolved to a corporation or alliance
  -- by an invoker-rights policy (that needs public.registration, which RLS hides
  -- from everyone but its owner), which is what used to force a definer bridge.
  reporter_id uuid references public.registration(id) on delete set null,
  -- Audit metadata, and the ownership fallback for rows orphaned when a
  -- character is unlinked (reporter_id nulled): those stay visible and deletable
  -- to their submitter, and invisible to everyone else.
  created_by uuid not null references auth.users(id) on delete cascade default auth.uid(),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index mercenary_den_enemy_intel_reinforcement_end_idx
  on public.mercenary_den_enemy_intel (reinforcement_end);
create index mercenary_den_enemy_intel_reporter_id_idx
  on public.mercenary_den_enemy_intel (reporter_id);

alter table public.mercenary_den_enemy_intel enable row level security;

-- A submitter always sees their own reports, shared or not.
create policy "Users read own enemy den intel"
  on public.mercenary_den_enemy_intel
  for select
  to authenticated
  using (
    reporter_id in (select id from public.registration where user_id = (select auth.uid()))
    or (reporter_id is null and created_by = (select auth.uid()))
  );

-- Corp/alliance mates read another user's reports exactly when that reporter's
-- own dens are visible to them — the same helper, audience and opt-out that gate
-- real dens. Additive/permissive: OR'd with "Users read own enemy den intel".
create policy "Alliance members read shared enemy den intel"
  on public.mercenary_den_enemy_intel
  for select
  to authenticated
  using (public.mercenary_den_shared_with_caller(reporter_id));

-- A user can only post (and later remove) intel attributed to one of their own
-- characters. created_by is still pinned to the caller so the orphan fallback
-- above can't be forged.
create policy "Authenticated insert own enemy den intel"
  on public.mercenary_den_enemy_intel
  for insert
  to authenticated
  with check (
    created_by = (select auth.uid())
    and reporter_id in (select id from public.registration where user_id = (select auth.uid()))
  );

create policy "Authenticated delete own enemy den intel"
  on public.mercenary_den_enemy_intel
  for delete
  to authenticated
  using (
    reporter_id in (select id from public.registration where user_id = (select auth.uid()))
    or (reporter_id is null and created_by = (select auth.uid()))
  );

-- Removal is a soft delete (stamping deleted_at), so the submitter needs update
-- on their own rows.
create policy "Authenticated soft-delete own enemy den intel"
  on public.mercenary_den_enemy_intel
  for update
  to authenticated
  using (
    reporter_id in (select id from public.registration where user_id = (select auth.uid()))
    or (reporter_id is null and created_by = (select auth.uid()))
  )
  with check (
    reporter_id in (select id from public.registration where user_id = (select auth.uid()))
    or (reporter_id is null and created_by = (select auth.uid()))
  );


grant select, insert, update, delete on public.mercenary_den_enemy_intel to authenticated;
grant all                    on public.mercenary_den_enemy_intel to service_role;

-- ── character_clone_state ──────────────────────────────────────────────────
-- Character-level fields from ESI /characters/{id}/clones/, written by the
-- character-clones job alongside the per-clone SCD rows: when the last clone
-- jump happened and when the home station was last changed. Live current-state
-- data, like character_location. "Next jump available" is derived as
-- last_clone_jump_date + 24h (conservative; Infomorph Synchronizing shortens
-- it, but reading the skill would need the esi-skills.read_skills.v1 scope).
create table public.character_clone_state (
  registration_id uuid primary key references public.registration(id) on delete cascade,
  last_clone_jump_date timestamptz,
  last_station_change_date timestamptz,
  recorded_at timestamptz not null default now()
);

alter table public.character_clone_state enable row level security;
create policy "Users read own clone state"
  on public.character_clone_state
  for select
  to authenticated
  using (
    registration_id in (
      select id from public.registration where user_id = (select auth.uid())
    )
  );

grant select on public.character_clone_state to authenticated;
grant all    on public.character_clone_state to service_role;

-- ── corp_structure ────────────────────────────────────────────────────────
-- ESI /corporations/{id}/structures/, written by the corp-structures job.
create table public.corp_structure (
  structure_id bigint primary key,
  corporation_id bigint not null,
  type_id bigint not null,
  system_id bigint not null,
  name text,
  state text,
  unanchors_at timestamptz,
  reinforce_hour int,
  next_reinforce_hour int,
  next_reinforce_apply timestamptz,
  next_reinforce_weekday int,
  services jsonb,
  last_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index corp_structure_corporation_id_idx on public.corp_structure (corporation_id);

alter table public.corp_structure enable row level security;
create policy "Users read structures for own corps"
  on public.corp_structure
  for select
  to authenticated
  using (
    corporation_id in (
      select corporation_id from public.registration
      where user_id = (select auth.uid()) and corporation_id is not null
    )
  );

-- Open corp_structure viewing to alliance-mates: a structure whose owning
-- corporation's alliance is one of the alliances the caller's own characters'
-- corporations belong to. Additive/permissive — OR'd with the own-corps policy
-- above. Fuel and the reinforcement profile stay private: they live in
-- corp_structure_status (below), which keeps the own-corps-only policy.
create policy "Alliance members read corp structures"
  on public.corp_structure
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.corporation owner_corp
      where owner_corp.corporation_id = corp_structure.corporation_id
        and owner_corp.alliance_id is not null
        and owner_corp.alliance_id in (
          select member_corp.alliance_id
          from public.registration r
          join public.corporation member_corp on member_corp.corporation_id = r.corporation_id
          where r.user_id = (select auth.uid())
            and member_corp.alliance_id is not null
        )
    )
  );

grant select on public.corp_structure to authenticated;
grant all    on public.corp_structure to service_role;

-- ── corp_structure_status ──────────────────────────────────────────────────
-- The private per-structure state — fuel timer and reinforcement profile — split
-- off corp_structure so it can stay own-corp only while corp_structure opens up
-- to alliance-mates. One row per structure, pointing back to it.
create table public.corp_structure_status (
  structure_id bigint primary key references public.corp_structure (structure_id) on delete cascade,
  corporation_id bigint not null,
  fuel_expires timestamptz,
  profile_id bigint,
  updated_at timestamptz not null default now()
);
create index corp_structure_status_corporation_id_idx on public.corp_structure_status (corporation_id);

alter table public.corp_structure_status enable row level security;
create policy "Users read structure status for own corps"
  on public.corp_structure_status
  for select
  to authenticated
  using (
    corporation_id in (
      select corporation_id from public.registration
      where user_id = (select auth.uid()) and corporation_id is not null
    )
  );

grant select on public.corp_structure_status to authenticated;
grant all    on public.corp_structure_status to service_role;

-- ── corp_structure_rig ────────────────────────────────────────────────────
-- Rigs (and other fitted modules) in Upwell structures. ESI has no dedicated
-- structure-fitting endpoint; these come from the corporation assets endpoint
-- (the corp-assets job) as items whose location_id is the structure_id and
-- location_flag is a RigSlot (RigSlot0..RigSlot7).
create table public.corp_structure_rig (
  structure_id bigint not null,
  location_flag text not null,
  type_id bigint not null,
  corporation_id bigint not null,
  updated_at timestamptz not null default now(),
  primary key (structure_id, location_flag)
);
create index corp_structure_rig_corporation_id_idx on public.corp_structure_rig (corporation_id);

alter table public.corp_structure_rig enable row level security;
create policy "Users read structure rigs for own corps"
  on public.corp_structure_rig
  for select
  to authenticated
  using (
    corporation_id in (
      select corporation_id from public.registration
      where user_id = (select auth.uid()) and corporation_id is not null
    )
  );

grant select on public.corp_structure_rig to authenticated;
grant all    on public.corp_structure_rig to service_role;

-- ── industry_system_index ─────────────────────────────────────────────────
-- ESI /industry/systems/, written by the industry-systems job: history of
-- EVE's per-system industry cost indices, snapshotted each run for every solar
-- system we have a structure anchored in. Public ESI data, so it's readable by
-- everyone. Each row is one system / activity (manufacturing, reaction,
-- copying, invention, ...) and the recorded cost index at recorded_at; the
-- table is append-only so the indices' drift over time can be charted.
create table public.industry_system_index (
  id bigint generated always as identity primary key,
  system_id bigint not null,
  activity text not null,
  cost_index real not null,
  recorded_at timestamptz not null default now()
);
create index industry_system_index_system_activity_idx
  on public.industry_system_index (system_id, activity, recorded_at desc);

alter table public.industry_system_index enable row level security;
create policy "Everyone reads industry indexes"
  on public.industry_system_index
  for select
  to anon, authenticated
  using (true);

grant select on public.industry_system_index to anon, authenticated;
grant all    on public.industry_system_index to service_role;

-- ── alliance / corporation ────────────────────────────────────────────────
-- Universal id→name directories, not siloed by user — the same shape as
-- industry_system_index: whoever's data we're extracting, we all share one
-- copy. Populated whenever an alliance/corp is seen anywhere (a linked
-- character's own corp/alliance, corpmates, structure owners, wallet/journal
-- counterparties, ...), not just for corps/alliances a user has registered.
create table public.alliance (
  alliance_id bigint primary key,
  -- Nullable: the character-directory job records the id from an affiliation
  -- pull and backfills the name from a bulk universe/names lookup, which may lag
  -- a run. A directory keyed by id shouldn't drop the id when the name misses.
  name text,
  updated_at timestamptz not null default now()
);

alter table public.alliance enable row level security;
create policy "Everyone reads alliances"
  on public.alliance
  for select
  to anon, authenticated
  using (true);

grant select on public.alliance to anon, authenticated;
grant all    on public.alliance to service_role;

create table public.corporation (
  corporation_id bigint primary key,
  name text,   -- nullable for the same reason as alliance.name (above)
  alliance_id bigint references public.alliance (alliance_id),
  updated_at timestamptz not null default now()
);
create index corporation_alliance_id_idx on public.corporation (alliance_id);

alter table public.corporation enable row level security;
create policy "Everyone reads corporations"
  on public.corporation
  for select
  to anon, authenticated
  using (true);

grant select on public.corporation to anon, authenticated;
grant all    on public.corporation to service_role;

-- ── character (directory) ─────────────────────────────────────────────────
-- World-readable directory of EVE characters: public identity only (name,
-- corporation, alliance) plus the registration uuid the extract tables key
-- owners by. This is the "character" table in docs/sharing-layer/design.md;
-- named character_directory because "character" is a SQL reserved word, and to
-- stay distinct from the character_* extract tables (owned data). It carries NO
-- user_id — that would let anyone correlate a user's alts — so it can be public
-- while registration (the account binding) stays owner-only, letting the sharing
-- layer resolve a shared row's owner via a plain RLS join instead of a SECURITY
-- DEFINER bridge. Populated by the character-directory extract job (which also
-- fills corporation.alliance_id and the alliance/corporation name rows from the
-- same affiliation pull).
create table public.character_directory (
  character_id bigint primary key,
  name text,
  corporation_id bigint,
  alliance_id bigint,
  -- The registration this character is linked to, if any (unique: a character
  -- links to at most one account). Extract tables key owners by registration
  -- uuid, so this is the join back to a public name/corp/alliance. on delete set
  -- null keeps the public directory row when an account unlinks the character.
  registration_id uuid unique references public.registration (id) on delete set null,
  updated_at timestamptz not null default now()
);
create index character_directory_corporation_id_idx on public.character_directory (corporation_id);

alter table public.character_directory enable row level security;
create policy "Everyone reads the character directory"
  on public.character_directory
  for select
  to anon, authenticated
  using (true);

grant select on public.character_directory to anon, authenticated;
grant all    on public.character_directory to service_role;

-- ── character_fitting_share: audience + widening policies ─────────────────
-- Placed after character_directory (not beside the share table) because these
-- expressions reference it, and a policy expression or function called by one
-- is parsed against the catalog at creation time.
--
-- Everything here runs as the QUERYING user — no SECURITY DEFINER — so every
-- table referenced inside a policy is filtered by its own RLS. That shapes the
-- whole design, the same way it shaped the mercenary-den layer: the owner's
-- corp/alliance must come from the world-readable character_directory (a
-- registration join would come up empty for anyone but the owner), and the
-- audience must be able to read the share rows aimed at them, or the widening
-- policy's probe of the share table would see nothing.

-- Members of the audience read the share rows aimed at them —
-- character_mercenary_den_share's "Alliance members read shares to their
-- alliances", adapted to a per-fit share whose audience is derived from the
-- owner's live affiliation rather than stored on the row (or, for 'public',
-- is simply every signed-in user). Load-bearing for
-- fitting_shared_with_caller() below, which sees exactly the rows this policy
-- (OR'd with "Users read own fitting shares") exposes. SELECT is the only
-- command this widens — inserts and deletes stay owner-only (see the
-- per-command policies at the table).
create policy "Audience reads fitting shares aimed at them"
  on public.character_fitting_share
  for select
  to authenticated
  using (
    level = 'public'
    or exists (
      select 1
      from public.character_directory owner
      where owner.registration_id = character_fitting_share.registration_id
        and (
          (
            character_fitting_share.level = 'corporation'
            and owner.corporation_id in (select public.my_corporation_ids())
          )
          or (
            character_fitting_share.level = 'alliance'
            and owner.alliance_id in (select public.my_alliance_ids())
          )
        )
    )
  );

-- True when the given fit carries a share whose audience the caller currently
-- belongs to: their corp, their alliance, or (level 'public') any signed-in
-- user — mercenary_den_shared_with_caller's shape, on invoker rights: it
-- reads only what the caller may already read (share rows via the policy
-- above, the world-readable character_directory, their own registrations via
-- my_corporation_ids()/my_alliance_ids()). The parameters are named after the
-- (registration_id, fitting_id) pair that is a fit's durable key — which is
-- why the body qualifies them with the function name: the joined tables carry
-- columns of the same names, and in a SQL function body an unqualified name
-- that matches a column resolves to the column. The directory join is a LEFT
-- join so an owner with no character_directory row yet (the
-- character-directory job runs daily) blocks only the membership levels, not
-- 'public'.
create or replace function public.fitting_shared_with_caller(registration_id uuid, fitting_id bigint)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.character_fitting_share s
    left join public.character_directory owner on owner.registration_id = s.registration_id
    where s.registration_id = fitting_shared_with_caller.registration_id
      and s.fitting_id = fitting_shared_with_caller.fitting_id
      and (
        s.level = 'public'
        or (s.level = 'corporation' and owner.corporation_id in (select public.my_corporation_ids()))
        or (s.level = 'alliance' and owner.alliance_id in (select public.my_alliance_ids()))
      )
  );
$$;

grant execute on function public.fitting_shared_with_caller(uuid, bigint) to authenticated;

-- The widening itself: a second, additive SELECT policy (Postgres ORs
-- permissive policies for the same role) layered on top of "Users read own
-- fittings", inherited by the security_invoker character_fitting view. An
-- earlier version inlined this with the owner's affiliation joined from
-- registration and no audience policy on the share table — both RLS-filtered
-- as the querying user, so for the corp/alliance mate the subquery always came
-- up empty and the policy never matched anything.
create policy "Audience reads shared fittings"
  on public.character_fitting_over_time
  for select
  to authenticated
  using (public.fitting_shared_with_caller(registration_id, fitting_id));

-- ── corp_wallet_journal ───────────────────────────────────────────────────
-- ESI /corporations/{id}/wallets/{division}/journal/, written by the
-- corp-wallet-journal job.
create table public.corp_wallet_journal (
  corporation_id bigint not null,
  division smallint not null,
  entry_id bigint not null,
  date timestamptz not null,
  ref_type text not null,
  amount numeric(20, 2),
  balance numeric(20, 2),
  reason text,
  description text,
  first_party_id bigint,
  second_party_id bigint,
  context_id bigint,
  context_id_type text,
  tax numeric(20, 2),
  tax_receiver_id bigint,
  seen_at timestamptz not null default now(),
  primary key (corporation_id, division, entry_id)
);
create index corp_wallet_journal_corp_date_idx on public.corp_wallet_journal (corporation_id, date desc);

alter table public.corp_wallet_journal enable row level security;
create policy "Users read journal for own corps"
  on public.corp_wallet_journal
  for select
  to authenticated
  using (
    corporation_id in (
      select corporation_id from public.registration
      where user_id = (select auth.uid()) and corporation_id is not null
    )
  );

grant select on public.corp_wallet_journal to authenticated;
grant all    on public.corp_wallet_journal to service_role;

-- ── corp_wallet_transaction ───────────────────────────────────────────────
-- ESI /corporations/{id}/wallets/{division}/transactions/, written by the
-- corp-wallet-transactions job. Market transactions (buys and sells) pulled
-- from every corporation wallet division
-- (esi-wallet.read_corporation_wallets.v1), unioned into the market page beside
-- the per-character character_wallet_transaction rows. `character_id` is the
-- registration whose token scanned the row; RLS scopes reads to that
-- character's owner, so a corp transaction is only visible to the player who
-- pulled it (like personal transactions). transaction_id is globally unique in
-- EVE, so it keys the table and dedupes across divisions and re-scans (first
-- scanner wins attribution). Corp transactions have no is_personal flag.
create table public.corp_wallet_transaction (
  transaction_id bigint primary key,
  registration_id uuid not null references public.registration(id) on delete cascade,
  corporation_id bigint not null,
  division smallint not null,
  date timestamptz not null,
  type_id bigint not null,
  quantity bigint not null,
  unit_price numeric(20, 2) not null,
  is_buy boolean not null,
  client_id bigint not null,
  location_id bigint not null,
  journal_ref_id bigint not null,
  seen_at timestamptz not null default now()
);
create index corp_wallet_transaction_registration_id_date_idx on public.corp_wallet_transaction (registration_id, date desc);

alter table public.corp_wallet_transaction enable row level security;
create policy "Users read own corp transactions"
  on public.corp_wallet_transaction
  for select
  to authenticated
  using (
    registration_id in (
      select id from public.registration where user_id = (select auth.uid())
    )
  );

grant select on public.corp_wallet_transaction to authenticated;
grant all    on public.corp_wallet_transaction to service_role;

-- ── corp_asset_over_time ──────────────────────────────────────────────────
-- ESI /corporations/{id}/assets/ (esi-assets.read_corporation_assets.v1),
-- written by the corp-assets job. SCD Type 2 history of a corporation's assets,
-- mirroring character_asset_over_time for per-character assets: is_current=true
-- rows form the current snapshot, valid_until is bumped each run for unchanged
-- items, and a new row is inserted when anything changes (old row's is_current
-- set false). Sourced from the same ESI pull that feeds corp_structure_rig.
create table public.corp_asset_over_time (
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
  valid_from timestamptz not null default now(),
  valid_until timestamptz not null default now()
);
create index corp_asset_over_time_corporation_id_idx on public.corp_asset_over_time (corporation_id);
-- At most one live row per item; also the conflict target the reconcile relies on.
create unique index corp_asset_over_time_current_item_idx on public.corp_asset_over_time (item_id) where is_current;
-- Time-travel lookups walking an item's version history.
create index corp_asset_over_time_item_id_idx on public.corp_asset_over_time (item_id, valid_until desc);

alter table public.corp_asset_over_time enable row level security;
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

-- Live snapshot of corp assets. security_invoker keeps the underlying RLS in
-- force for the querying (authenticated) role rather than running as the view owner.
create view public.corp_asset with (security_invoker = on) as
  select * from public.corp_asset_over_time where is_current;

grant select on public.corp_asset_over_time to authenticated;
grant select on public.corp_asset           to authenticated;
grant all    on public.corp_asset_over_time to service_role;

-- ── corp asset aggregation functions ──────────────────────────────────────
-- Mirrors the character asset aggregation functions above over the corp asset
-- history, so the assets pages can show corp hangars beside character hangars
-- without paging every corp asset into Node. Corp assets nest through office
-- folders and containers the same way character assets nest through ships.
-- Both are SECURITY INVOKER, so corp_asset(_over_time) RLS keeps reads scoped
-- to corporations the caller has a registered character in.

-- assets index (/asset): stacks per root location, split by owning corp.
create or replace function public.corp_asset_location_summary()
returns table (location_id bigint, location_type text, corporation_id bigint, stacks bigint, station_name text, system_id bigint)
language sql
stable
as $$
  with recursive parent_of as (
    -- One best-known parent per item the caller can see: the live row if there
    -- is one, otherwise the most recent historical sighting, so the walk can
    -- bridge a container that momentarily dropped out of the current snapshot.
    select distinct on (item_id) item_id, location_id, location_type
    from public.corp_asset_over_time
    order by item_id, is_current desc, valid_until desc
  ),
  walk as (
    select
      a.item_id        as start_item,
      a.corporation_id as corporation_id,
      a.location_id    as location_id,
      a.location_type  as location_type,
      1                as depth
    from public.corp_asset a
    union all
    select
      w.start_item,
      w.corporation_id,
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
    w.corporation_id,
    count(*) as stacks,
    st.name as station_name,
    st.system_id
  from walk w
  left join public.sde_station st on st.station_id = w.location_id
  where w.location_id is not null
    and not exists (select 1 from parent_of o where o.item_id = w.location_id)
  group by w.location_id, w.location_type, w.corporation_id, st.name, st.system_id;
$$;

-- per-location page (/asset/[locationId]): for each corp item sitting directly
-- in `parent`, the number of items nested inside it (the whole subtree,
-- excluding the item itself).
create or replace function public.corp_asset_location_contents(parent bigint)
returns table (item_id bigint, contents bigint)
language sql
stable
as $$
  with recursive descend as (
    select a.item_id as root_child, a.item_id as node, 1 as depth
    from public.corp_asset a
    where a.location_id = parent
    union all
    select d.root_child, c.item_id, d.depth + 1
    from descend d
    join public.corp_asset c on c.location_id = d.node
    where d.depth < 64
  )
  select root_child as item_id, count(*) - 1 as contents
  from descend
  group by root_child;
$$;

-- item search (/asset/search): mirrors character_asset_search() over corp
-- assets, seeded from just the matched items.
create or replace function public.corp_asset_search(type_ids bigint[])
returns table (
  item_id bigint,
  corporation_id bigint,
  type_id bigint,
  quantity bigint,
  is_singleton boolean,
  location_flag text,
  root_location_id bigint,
  root_location_type text,
  contents bigint,
  type_name text,
  root_location_name text,
  system_id bigint,
  parent_id bigint,
  parent_type_id bigint
)
language sql
stable
as $$
  with recursive parent_of as (
    select distinct on (item_id) item_id, location_id, location_type
    from public.corp_asset_over_time
    order by item_id, is_current desc, valid_until desc
  ),
  matched as (
    select a.item_id, a.corporation_id, a.type_id, a.quantity, a.is_singleton,
           a.location_flag, a.location_id, a.location_type
    from public.corp_asset a
    where a.type_id = any(type_ids)
  ),
  climb as (
    select m.item_id as start_item, m.location_id, m.location_type, 1 as depth
    from matched m
    union all
    select c.start_item, p.location_id, p.location_type, c.depth + 1
    from climb c
    join parent_of p on p.item_id = c.location_id
    where c.depth < 64
  ),
  roots as (
    select w.start_item, w.location_id as root_location_id, w.location_type as root_location_type
    from climb w
    where w.location_id is not null
      and not exists (select 1 from parent_of o where o.item_id = w.location_id)
  ),
  descend as (
    select m.item_id as ancestor, m.item_id as node, 1 as depth
    from matched m
    union all
    select d.ancestor, c.item_id, d.depth + 1
    from descend d
    join public.corp_asset c on c.location_id = d.node
    where d.depth < 64
  ),
  contents as (
    select ancestor, count(*) - 1 as contents
    from descend
    group by ancestor
  )
  select
    m.item_id,
    m.corporation_id,
    m.type_id,
    m.quantity,
    m.is_singleton,
    m.location_flag,
    r.root_location_id,
    r.root_location_type,
    coalesce(ct.contents, 0) as contents,
    t.name as type_name,
    st.name as root_location_name,
    st.system_id,
    m.location_id as parent_id,
    p.type_id as parent_type_id
  from matched m
  join roots r on r.start_item = m.item_id
  left join contents ct on ct.ancestor = m.item_id
  left join public.sde_published_type t on t.type_id = m.type_id
  left join public.sde_station st on st.station_id = r.root_location_id
  left join public.corp_asset p on p.item_id = m.location_id;
$$;

grant execute on function public.corp_asset_location_summary()        to authenticated;
grant execute on function public.corp_asset_location_contents(bigint) to authenticated;
grant execute on function public.corp_asset_search(bigint[])          to authenticated;

-- breadcrumb (/asset/[locationId], /ship/[itemId]): the materialized path of
-- one item — the item itself, then each enclosing container outward, ordered
-- by depth. The last row's location_id/location_type is the root place (a
-- station, structure or solar system that isn't one of the caller's items).
-- Climbs the live character_asset ∪ corp_asset views, so RLS scopes every
-- hop to the caller; a parent the caller can't see just ends the walk early.
-- Seeded from a single item (like the *_asset_search functions), so it stays
-- cheap regardless of hangar size.
create or replace function public.asset_ancestors(start_id bigint)
returns table (item_id bigint, type_id bigint, name text, location_id bigint, location_type text, depth int, type_name text)
language sql
stable
as $$
  with recursive parent_of as (
    select item_id, type_id, name, location_id, location_type
    from public.character_asset
    union all
    select item_id, type_id, null::text as name, location_id, location_type
    from public.corp_asset
  ),
  walk as (
    select p.item_id, p.type_id, p.name, p.location_id, p.location_type, 1 as depth
    from parent_of p
    where p.item_id = start_id
    union all
    select p.item_id, p.type_id, p.name, p.location_id, p.location_type, w.depth + 1
    from walk w
    join parent_of p on p.item_id = w.location_id
    where w.depth < 16
  )
  select w.item_id, w.type_id, w.name, w.location_id, w.location_type, w.depth, t.name as type_name
  from walk w
  left join public.sde_published_type t on t.type_id = w.type_id
  order by w.depth;
$$;

grant execute on function public.asset_ancestors(bigint) to authenticated;

-- /api/corp/assets IMPORTDATA endpoint: the caller's corporation(s) current
-- asset rows (one per item stack), mirroring character_asset_snapshot_at()'s
-- shape for the per-character assets endpoint. Returns json (not jsonb) so
-- json_build_object's key order is preserved for the sheet's columns, and a
-- single scalar sidesteps PostgREST's max-rows cap.
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
    where id = any(character_ids) and corporation_id is not null
  );
$$;

grant execute on function public.corp_assets(uuid[]) to service_role;

-- ── corp_blueprint_over_time ──────────────────────────────────────────────
-- ESI /corporations/{id}/blueprints/, written by the corp-blueprints job. SCD
-- Type 2 history of a corporation's blueprints, mirroring
-- character_blueprint_over_time for per-character blueprints: is_current=true
-- rows form the current snapshot, valid_until is bumped each run for
-- unchanged blueprints, and a new row is inserted when anything tracked
-- changes (old row's is_current set false).
create table public.corp_blueprint_over_time (
  id bigint generated always as identity primary key,
  item_id bigint not null,
  corporation_id bigint not null,
  type_id bigint not null,
  location_id bigint,
  location_flag text,
  quantity bigint,
  material_efficiency smallint,
  time_efficiency smallint,
  runs integer,
  is_current boolean not null default true,
  valid_from timestamptz not null default now(),
  valid_until timestamptz not null default now()
);
create index corp_blueprint_over_time_corporation_id_idx on public.corp_blueprint_over_time (corporation_id);
-- At most one live row per item; also the conflict target the extract relies on.
create unique index corp_blueprint_over_time_current_item_idx on public.corp_blueprint_over_time (item_id) where is_current;
-- Time-travel lookups walking an item's version history.
create index corp_blueprint_over_time_item_id_idx on public.corp_blueprint_over_time (item_id, valid_until desc);

alter table public.corp_blueprint_over_time enable row level security;
create policy "Users read blueprints for own corps"
  on public.corp_blueprint_over_time
  for select
  to authenticated
  using (
    corporation_id in (
      select corporation_id from public.registration
      where user_id = (select auth.uid()) and corporation_id is not null
    )
  );

-- Live snapshot of corp blueprints. security_invoker keeps the underlying RLS
-- in force for the querying (authenticated) role rather than running as the view owner.
create view public.corp_blueprint with (security_invoker = on) as
  select * from public.corp_blueprint_over_time where is_current;

grant select on public.corp_blueprint_over_time to authenticated;
grant select on public.corp_blueprint           to authenticated;
grant all    on public.corp_blueprint_over_time to service_role;

-- /api/corp/blueprints IMPORTDATA endpoint: the caller's corporation(s)
-- current blueprint rows, mirroring corp_assets()'s shape for the
-- per-corporation assets endpoint.
create or replace function public.corp_blueprints(character_ids uuid[])
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
    where id = any(character_ids) and corporation_id is not null
  );
$$;

grant execute on function public.corp_blueprints(uuid[]) to service_role;

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
      b.registration_id::text                                 as owner_id,
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
      and (character_ids is null or b.registration_id = any(character_ids))
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

-- ── corp_industry_job_over_time ───────────────────────────────────────────
-- ESI /corporations/{id}/industry/jobs/ (esi-industry.read_corporation_jobs.v1),
-- written by the corp-industry-jobs job, once per corp per run. SCD Type 2
-- history mirroring character_industry_job_over_time (plus corporation_id);
-- installer_id is the character who started the job. Same reconcile: a job's
-- status transitions open new versions, and a job that drops out of the ESI
-- listing keeps its terminal row is_current rather than being closed, so the
-- corp_industry_job view retains every job the endpoint ever reported.
create table public.corp_industry_job_over_time (
  id bigint generated always as identity primary key,
  job_id bigint not null,
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
  is_current boolean not null default true,
  valid_from timestamptz not null default now(),
  valid_until timestamptz not null default now()
);
create index corp_industry_job_over_time_corporation_id_idx on public.corp_industry_job_over_time (corporation_id);
-- At most one live row per job; also the conflict target the reconcile relies on.
create unique index corp_industry_job_over_time_current_job_idx on public.corp_industry_job_over_time (job_id) where is_current;
-- Time-travel lookups walking a job's version history.
create index corp_industry_job_over_time_job_id_idx on public.corp_industry_job_over_time (job_id, valid_until desc);

alter table public.corp_industry_job_over_time enable row level security;
create policy "Users read industry jobs for own corps"
  on public.corp_industry_job_over_time
  for select
  to authenticated
  using (
    corporation_id in (
      select corporation_id from public.registration
      where user_id = (select auth.uid()) and corporation_id is not null
    )
  );

-- Live snapshot of corp industry jobs. security_invoker keeps the underlying RLS
-- in force for the querying (authenticated) role rather than running as the view owner.
create view public.corp_industry_job with (security_invoker = on) as
  select * from public.corp_industry_job_over_time where is_current;

grant select on public.corp_industry_job_over_time to authenticated;
grant select on public.corp_industry_job           to authenticated;
grant all    on public.corp_industry_job_over_time to service_role;

-- /api/corp/jobs IMPORTDATA endpoint: the caller's corporation(s) industry
-- jobs, mirroring character_industry_jobs()'s shape for the per-character
-- endpoint. Returns json (not jsonb) so json_build_object's key order is
-- preserved for the sheet's columns, and a single scalar sidesteps PostgREST's
-- max-rows cap.
-- `as_of` (default now) time-travels through the SCD-2 history exactly like the
-- per-character character_industry_jobs above.
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
    where id = any(character_ids) and corporation_id is not null
  )
  and j.valid_from <= as_of
  and (j.is_current or j.valid_until >= as_of)
  and (include_delivered or j.status not in ('delivered', 'cancelled', 'archived'));
$$;

grant execute on function public.corp_industry_jobs(uuid[], boolean, timestamptz) to service_role;

-- ── universe_name ─────────────────────────────────────────────────────────
-- ESI /universe/names/, written by the universe-names job: cache of resolved
-- EVE id -> name/category lookups.
create table public.universe_name (
  id bigint primary key,
  name text not null,
  category text not null,
  resolved_at timestamptz not null default now()
);

alter table public.universe_name enable row level security;
create policy "Authenticated read universe_name"
  on public.universe_name
  for select
  to authenticated
  using (true);

grant select on public.universe_name to authenticated;
grant all    on public.universe_name to service_role;

-- ── character_affiliation ─────────────────────────────────────────────────
-- ESI /characters/affiliation/, written by the character-affiliations job:
-- which corporation each known character currently belongs to.
create table public.character_affiliation (
  character_id bigint primary key,
  corporation_id bigint not null,
  resolved_at timestamptz not null default now()
);

alter table public.character_affiliation enable row level security;
create policy "Authenticated read character_affiliation"
  on public.character_affiliation
  for select
  to authenticated
  using (true);

grant select on public.character_affiliation to authenticated;
grant all    on public.character_affiliation to service_role;

-- ── universe_structure ────────────────────────────────────────────────────
-- ESI /universe/structures/{id}, written by the universe-structures job: cache
-- of player Upwell structure details (name, system) resolved from the
-- authenticated endpoint. Lets the assets UI show a name/system for structures
-- that aren't our own corp's (those live in corp_structure).
create table public.universe_structure (
  structure_id bigint primary key,
  name text,
  system_id bigint,
  type_id bigint,
  resolved_at timestamptz not null default now()
);

alter table public.universe_structure enable row level security;
create policy "Authenticated read universe_structure"
  on public.universe_structure
  for select
  to authenticated
  using (true);

grant select on public.universe_structure to authenticated;
grant all    on public.universe_structure to service_role;

-- ── user_settings ─────────────────────────────────────────────────────────
-- Per-user preferences. `enabled_scopes` is the set of ESI OAuth scopes the
-- user has opted into requesting when they add a character; an absent row means
-- "request everything" (see src/app/character/userScopes.ts).
-- `api_token` is an opaque per-user secret the Google Sheets IMPORTDATA endpoints
-- (/api/character/assets etc.) authenticate with — those requests carry no
-- Supabase session, so the routes look the user up by this token (service role)
-- and scope the results to their characters. Null until the user generates one
-- in settings.
-- `flags` is the set of Vercel Flags (src/flags.ts) a user has enabled, e.g.
-- 'mercenary-dens' gates the /mercenary-dens page and nav link per-user.
-- 'corpses' both shows the owner's nav link and opts their account into the
-- public /corpses/[characterID] share page — an account without it set renders
-- as a 404 there.
create table public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  enabled_scopes text[] not null default '{}',
  api_token text unique,
  flags text[] not null default '{}',
  updated_at timestamptz not null default now()
);

alter table public.user_settings enable row level security;
create policy "Users manage own settings"
  on public.user_settings
  for all
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

grant select, insert, update, delete on public.user_settings to authenticated;
grant all                            on public.user_settings to service_role;

-- ── watched_system ────────────────────────────────────────────────────────
-- Per-user list of solar systems to watch industry cost indices for. The
-- industry-systems extract pulls the union of every user's watched systems
-- (plus the systems we hold structures in) each run, and the /indexes page
-- renders one sparkline row per watched system. System ids come from the
-- locally generated SDE data (src/sdeSystems.ts), so no ESI lookup is needed
-- to add one.
create table public.watched_system (
  user_id uuid not null references auth.users(id) on delete cascade,
  system_id bigint not null,
  created_at timestamptz not null default now(),
  primary key (user_id, system_id),
  -- Drag order on the /indexes page (lower sorts first). watchSystem() assigns
  -- new rows the next position; reorderWatchedSystems() rewrites the whole
  -- list in one request when the user drags a row. Kept last to match the
  -- add-column migration's column order.
  position integer not null default 0
);
create index watched_system_user_id_idx on public.watched_system (user_id);

alter table public.watched_system enable row level security;
create policy "Users manage own watched systems"
  on public.watched_system
  for all
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

grant select, insert, update, delete on public.watched_system to authenticated;
grant all                            on public.watched_system to service_role;

-- ── invite_code ───────────────────────────────────────────────────────────
-- Invite-only registration. A new account can only be created by redeeming an
-- unused code, and users earn the ability to mint codes over time (the first a
-- week after adding their first character via SSO, then after 2, 4, 8, … weeks
-- — the gap doubling each time; see src/app/account/invite).
-- `created_by` is null for seed codes inserted by hand to bootstrap the system.
-- `redeemed_by` is the account that signed up with the code; null while the code
-- is still "to give out". `is_chancellor` marks a code that confers Chancellor
-- powers: the account that redeems such a code is a Chancellor (see
-- src/app/account/chancellor), which lets it mint invite codes without waiting on
-- the earning schedule. Set only by the service role — authenticated users have a
-- read-only policy on their own codes and no write privilege, so a user cannot
-- flag a code (or themselves) as Chancellor.
create table public.invite_code (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  created_by uuid references auth.users(id) on delete cascade,
  redeemed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  redeemed_at timestamptz,
  -- Kept last to match the add-column migration's column order.
  is_chancellor boolean not null default false
);
create index invite_code_created_by_idx on public.invite_code (created_by);

alter table public.invite_code enable row level security;
-- Users may read the codes they own; minting and redeeming both run server-side
-- with the service role, so authenticated users get no write policy and cannot
-- fabricate codes that bypass the earning schedule.
create policy "Users read own invite codes"
  on public.invite_code
  for select
  to authenticated
  using (created_by = (select auth.uid()));

grant select on public.invite_code to authenticated;
grant all    on public.invite_code to service_role;

-- ── refresh_task ──────────────────────────────────────────────────────────
-- Tracks an on-demand "Refresh ESI" run (a per-cell refresh button on
-- /character/refresh, or the full pull dispatched when a character is added).
-- One row per dispatched unit of work: per character for the per-character extract jobs
-- (character-assets, character-orders, character-wallet,
-- character-wallet-transactions, character-industry-jobs,
-- corp-wallet-transactions) and one account-wide row each for
-- character-affiliations and universe-names. The server action inserts these
-- (status 'pending') and enqueues a matching queue message; the queue consumer
-- flips each to 'running' then 'done'/'error'. The /character/refresh page
-- reads them (scoped to the owner) to show live status.
create table public.refresh_task (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  job text not null,
  registration_id uuid references public.registration(id) on delete cascade,
  character_name text,
  status text not null default 'pending',
  started_at timestamptz,
  ended_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index refresh_task_batch_id_idx on public.refresh_task (batch_id);
create index refresh_task_user_id_created_at_idx on public.refresh_task (user_id, created_at desc);

alter table public.refresh_task enable row level security;
create policy "Users read own refresh tasks"
  on public.refresh_task
  for select
  to authenticated
  using (user_id = (select auth.uid()));

grant select on public.refresh_task to authenticated;
grant all    on public.refresh_task to service_role;

-- ── shared_asset_token ─────────────────────────────────────────────────────
-- Public share links for a user's own assets: /ship/[itemId]?token=… (and
-- /asset/[locationId]?token=… for hangars — no UI creates those yet). The
-- token is 16 random bytes hex, generated server-side (see
-- src/app/ship/[itemId]/actions.ts). Anonymous viewers never query this
-- table: the server resolves the token with the service-role client and then
-- explicitly scopes every asset query to the sharing user's characters/corps
-- — there is deliberately no anon/public policy here. item_id is whatever id
-- the shared URL carries: an asset item_id for ships, a location id for
-- hangars. A share dies with the account (cascade) or when the item stops
-- being visible as the sharer's (checked at view time), and can be revoked
-- by deleting the row.
create table public.shared_asset_token (
  token text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  item_id bigint not null,
  created_at timestamptz not null default now(),
  unique (user_id, item_id)
);
create index shared_asset_token_user_id_idx on public.shared_asset_token (user_id);

alter table public.shared_asset_token enable row level security;
create policy "Users manage own share tokens"
  on public.shared_asset_token
  for all
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

grant select, insert, update, delete on public.shared_asset_token to authenticated;
grant all    on public.shared_asset_token to service_role;

-- ── SDE mirror ───────────────────────────────────────────────────────────────────
-- Nightly-refreshed mirror of CCP's official Static Data Export, populated by
-- the `sde-mirror` Vercel Workflow (src/workflows/sdeMirror.ts /
-- src/jobs/sdeMirror.js, scheduled 12:21 UTC). One sde_<stem> table per JSONL
-- file in the export, minted at ingest via ensure_sde_mirror_table(); the
-- app-critical ones are pre-created so the views exist before the first run.
-- Readable by anyone (RLS with a bare SELECT policy, SELECT-only grants — no
-- write policies or grants for anon/authenticated); only the service-role
-- ingest writes.

create extension if not exists pg_trgm with schema extensions;

-- Create (or align) one SDE mirror table. SECURITY DEFINER so the ingest can
-- call it over PostgREST RPC; execute is service-role only, the stem is
-- regex-validated, and all DDL goes through format('%I'), so the service role
-- can only ever mint read-only sde_* mirror tables of this exact shape.
create or replace function public.ensure_sde_mirror_table(p_stem text, p_key_type text default 'bigint')
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_table text;
begin
  if p_stem !~ '^[a-z][a-z0-9_]{0,58}$' then
    raise exception 'invalid SDE mirror table stem: %', p_stem;
  end if;
  if p_key_type not in ('bigint', 'text') then
    raise exception 'invalid SDE mirror key type: %', p_key_type;
  end if;
  v_table := 'sde_' || p_stem;
  execute format(
    'create table if not exists public.%I (_key %s primary key, data jsonb not null, sde_build bigint not null)',
    v_table,
    p_key_type
  );
  execute format('alter table public.%I enable row level security', v_table);
  execute format('drop policy if exists "Anyone reads SDE data" on public.%I', v_table);
  execute format('create policy "Anyone reads SDE data" on public.%I for select using (true)', v_table);
  execute format('grant select on public.%I to anon, authenticated', v_table);
  -- The schema's default privileges hand new tables ALL to anon/authenticated;
  -- claw the write privileges back so the mirror is read-only at the grant
  -- layer too, not just via the missing write policies.
  execute format('revoke insert, update, delete on public.%I from anon, authenticated', v_table);
  execute format('grant select, insert, update, delete on public.%I to service_role', v_table);
end
$$;

revoke execute on function public.ensure_sde_mirror_table(text, text) from public, anon, authenticated;
grant execute on function public.ensure_sde_mirror_table(text, text) to service_role;

-- Pre-create the tables the app-facing views project from.
select public.ensure_sde_mirror_table(stem)
from unnest(
  array['types', 'groups', 'categories', 'map_solar_systems', 'map_constellations', 'map_regions',
        'npc_stations', 'blueprints', 'map_planets']
) as stem;

-- One row per SDE build the ingest has seen; completed_at set only when every
-- file landed, commit_sha records which code deployment produced that mirror.
-- The nightly run short-circuits (a ~5 s no-op) only when CCP's current build
-- already has a completed row, produced by the currently-deployed commit, and
-- less than 7 days old — so a new SDE build, a new deployment (transform
-- change), or 7-day staleness each force a full re-ingest.
create table public.sde_mirror_state (
  build_number bigint primary key,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  commit_sha text
);
alter table public.sde_mirror_state enable row level security;
create policy "Anyone reads SDE data" on public.sde_mirror_state for select using (true);
grant select on public.sde_mirror_state to anon, authenticated;
revoke insert, update, delete on public.sde_mirror_state from anon, authenticated;
grant select, insert, update, delete on public.sde_mirror_state to service_role;

-- NPC station display names. The SDE carries a station's structure (system,
-- type, owning corp, operation) but not its name — that's generated in-game
-- from those pieces — so the ingest resolves names via ESI /universe/names/
-- into this side table. Never swept by build: a failed ESI resolve degrades
-- to the previous run's names rather than an empty table.
create table public.sde_npc_station_name (
  station_id bigint primary key,
  name text not null,
  updated_at timestamptz not null default now()
);
alter table public.sde_npc_station_name enable row level security;
create policy "Anyone reads SDE data" on public.sde_npc_station_name for select using (true);
grant select on public.sde_npc_station_name to anon, authenticated;
revoke insert, update, delete on public.sde_npc_station_name from anon, authenticated;
grant select, insert, update, delete on public.sde_npc_station_name to service_role;

-- Storage for the eveship.fit protobuf data (the 6 files @eveshipfit/react's
-- EveDataProvider reads). The sde-mirror workflow encodes the .pb2 from the
-- sde_* mirror after each SDE build and upserts them here (src/jobs/esfData.js),
-- so the ship-fitting data refreshes when the SDE changes without a redeploy.
-- `data` is the base64-encoded protobuf bytes (text moves through PostgREST far
-- more simply than bytea; the serving route base64-decodes it). Public read
-- (non-sensitive static game data, same as the sde_* mirror); writes are
-- service-role only (the workflow).
create table public.esf_data (
  name text primary key,
  data text not null,
  sde_build bigint not null,
  updated_at timestamptz not null default now()
);
alter table public.esf_data enable row level security;
create policy "Everyone reads esf data" on public.esf_data for select to anon, authenticated using (true);
grant select on public.esf_data to anon, authenticated;
grant all    on public.esf_data to service_role;

-- The industry-planning spreadsheet's static CSVs (StaticInputs / StaticOutputs /
-- invention / types, in both twines and miros label modes), derived from the
-- sde_* mirror by the sde-mirror workflow's encodeSheets step (src/jobs/sheetCsv.js
-- -> encodeSheetCsv() in src/buildSheetCsv.js) after each SDE build, and served at
-- /sheets/[file] for Google Sheets =IMPORTDATA(). `data` is the CSV text itself
-- (no base64: CSV is already text, unlike esf_data's binary protobufs). Public
-- read (SDE-derived, no player data, identical for every caller); writes are
-- service-role only (the workflow).
create table public.sheet_csv (
  name text primary key,
  data text not null,
  sde_build bigint not null,
  updated_at timestamptz not null default now()
);
alter table public.sheet_csv enable row level security;
create policy "Everyone reads sheet csv" on public.sheet_csv for select to anon, authenticated using (true);
grant select on public.sheet_csv to anon, authenticated;
grant all    on public.sheet_csv to service_role;

-- Trigram indexes backing the ILIKE '%…%' in sde_search_type/sde_search_system.
create index sde_types_name_trgm on public.sde_types
  using gin ((data -> 'name' ->> 'en') extensions.gin_trgm_ops);
create index sde_map_solar_systems_name_trgm on public.sde_map_solar_systems
  using gin ((data -> 'name' ->> 'en') extensions.gin_trgm_ops);

-- ── App-shaped projections ──────────────────────────────────────────────────
-- The tuple shapes the app's SDE loaders (src/sde*.ts) use today, as views
-- over the raw jsonb mirror — the JOIN targets for the loader cutover and for
-- pushing name resolution into the asset/search functions later.

-- Published, named types with their group/category — mirrors buildSde.js's
-- buildTypes() cut. group_name/category_name added for the MCP exploration
-- tools (migration 20260723000000_sde_taxonomy_views); race_id/meta_group_id
-- for the /fitting ship matrix (migration 20260728120000_sde_type_race_meta).
create view public.sde_published_type
with (security_invoker = true) as
select
  t._key as type_id,
  t.data -> 'name' ->> 'en' as name,
  (t.data ->> 'groupID')::bigint as group_id,
  (g.data ->> 'categoryID')::bigint as category_id,
  g.data -> 'name' ->> 'en' as group_name,
  c.data -> 'name' ->> 'en' as category_name,
  (t.data ->> 'raceID')::bigint as race_id,
  (t.data ->> 'metaGroupID')::bigint as meta_group_id
from public.sde_types t
left join public.sde_groups g on g._key = (t.data ->> 'groupID')::bigint
left join public.sde_categories c on c._key = (g.data ->> 'categoryID')::bigint
where (t.data ->> 'published')::boolean
  and coalesce(trim(t.data -> 'name' ->> 'en'), '') <> '';

-- Known-space systems (30M id band): wormhole/abyssal systems never appear in
-- the industry cost-index feed — mirrors buildSde.js's buildSystems() cut. The
-- constellation/region columns come from migration 20260719120000.
create view public.sde_kspace_system
with (security_invoker = true) as
select
  s._key as system_id,
  s.data -> 'name' ->> 'en' as name,
  (s.data ->> 'securityStatus')::real as security,
  c._key as constellation_id,
  c.data -> 'name' ->> 'en' as constellation_name,
  r._key as region_id,
  r.data -> 'name' ->> 'en' as region_name
from public.sde_map_solar_systems s
left join public.sde_map_constellations c on c._key = (s.data ->> 'constellationID')::bigint
left join public.sde_map_regions r on r._key = (c.data ->> 'regionID')::bigint
where s._key >= 30000000
  and s._key < 31000000
  and coalesce(trim(s.data -> 'name' ->> 'en'), '') <> '';

-- NPC stations joined to their ESI-resolved display names.
create view public.sde_station
with (security_invoker = true) as
select
  s._key as station_id,
  n.name,
  (s.data ->> 'solarSystemID')::bigint as system_id
from public.sde_npc_stations s
join public.sde_npc_station_name n on n.station_id = s._key;

-- Planets with their system name (planets carry no display name in the SDE;
-- consumers derive "<system> <roman(celestial_index)>"). security + region_*
-- added for the MCP exploration tools (migration 20260723000000).
create view public.sde_planet
with (security_invoker = true) as
select
  p._key as planet_id,
  (p.data ->> 'solarSystemID')::bigint as system_id,
  (p.data ->> 'celestialIndex')::int as celestial_index,
  (p.data ->> 'typeID')::bigint as type_id,
  sys.data -> 'name' ->> 'en' as system_name,
  (sys.data ->> 'securityStatus')::real as security,
  r._key as region_id,
  r.data -> 'name' ->> 'en' as region_name
from public.sde_map_planets p
left join public.sde_map_solar_systems sys on sys._key = (p.data ->> 'solarSystemID')::bigint
left join public.sde_map_constellations con on con._key = (sys.data ->> 'constellationID')::bigint
left join public.sde_map_regions r on r._key = (con.data ->> 'regionID')::bigint;

-- Groups with their category, and categories/regions — the taxonomy + universe
-- browsers for the MCP exploration tools (migration 20260723000000).
create view public.sde_group
with (security_invoker = true) as
select
  g._key as group_id,
  g.data -> 'name' ->> 'en' as name,
  (g.data ->> 'categoryID')::bigint as category_id,
  c.data -> 'name' ->> 'en' as category_name,
  (g.data ->> 'published')::boolean as published
from public.sde_groups g
left join public.sde_categories c on c._key = (g.data ->> 'categoryID')::bigint;

create view public.sde_category
with (security_invoker = true) as
select
  _key as category_id,
  data -> 'name' ->> 'en' as name,
  (data ->> 'published')::boolean as published
from public.sde_categories;

-- K-space regions (10M id band), mirroring sde_kspace_system's exclusion of
-- wormhole (11M) and abyssal (12M+) space; Pochven is in-band.
create view public.sde_region
with (security_invoker = true) as
select
  _key as region_id,
  data -> 'name' ->> 'en' as name
from public.sde_map_regions
where _key >= 10000000
  and _key < 11000000
  and coalesce(trim(data -> 'name' ->> 'en'), '') <> '';

grant select on public.sde_published_type, public.sde_kspace_system, public.sde_station, public.sde_planet,
  public.sde_group, public.sde_category, public.sde_region
  to anon, authenticated, service_role;
revoke insert, update, delete on public.sde_published_type, public.sde_kspace_system, public.sde_station,
  public.sde_planet, public.sde_group, public.sde_category, public.sde_region from anon, authenticated;

-- Blueprint "consume materials → produce output" bill, unnested from the
-- activities jsonb once per ingest rather than per query: manufacturing (1)
-- and reactions (11) only, one row per (blueprint, activity, product) —
-- mirrors buildSde.js's buildBlueprints() cut. Materialized because the
-- lateral unnest over every blueprint is too slow to run per lookup; the
-- ingest's finalize step refreshes it via sde_refresh_views(). Created
-- populated-but-empty (sde_blueprints has no rows yet), which is what lets
-- the concurrent refresh below work on first run.
create materialized view public.sde_blueprint_product as
select
  b._key as blueprint_type_id,
  a.activity_id,
  (prod ->> 'typeID')::bigint as product_type_id,
  (prod ->> 'quantity')::bigint as product_quantity,
  coalesce(a.activity -> 'materials', '[]'::jsonb) as materials
from public.sde_blueprints b
cross join lateral (
  values (1, b.data -> 'activities' -> 'manufacturing'), (11, b.data -> 'activities' -> 'reaction')
) as a (activity_id, activity)
cross join lateral jsonb_array_elements(a.activity -> 'products') as prod
where jsonb_typeof(a.activity -> 'products') = 'array';

-- Unique index required by REFRESH MATERIALIZED VIEW CONCURRENTLY.
create unique index sde_blueprint_product_uq
  on public.sde_blueprint_product (product_type_id, blueprint_type_id, activity_id);
create index sde_blueprint_product_bp_idx on public.sde_blueprint_product (blueprint_type_id);
-- jsonb_path_ops GIN so "what consumes type X" is a @> containment probe.
create index sde_blueprint_product_materials_idx
  on public.sde_blueprint_product using gin (materials jsonb_path_ops);

-- Materialized views can't carry RLS; SELECT-only grants give the same
-- anyone-can-read, nobody-can-write access as the tables above.
grant select on public.sde_blueprint_product to anon, authenticated, service_role;

create or replace function public.sde_refresh_views()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  refresh materialized view concurrently public.sde_blueprint_product;
end
$$;

revoke execute on function public.sde_refresh_views() from public, anon, authenticated;
grant execute on function public.sde_refresh_views() to service_role;

-- ── Search ──────────────────────────────────────────────────────────────────
-- Case-insensitive substring search ranked exactly like src/sdeTypes.ts's
-- searchSdeTypesAll: coverage = query length / name length (a tighter match
-- ranks above a longer name containing the same term), tie-broken by shorter
-- name then id. ILIKE metacharacters in the query are escaped so they match
-- literally, mirroring the loaders' plain indexOf semantics.

create or replace function public.sde_search_type(q text, lim int default 25)
returns table (type_id bigint, name text, group_id bigint, category_id bigint, coverage real)
language sql
stable
set search_path = ''
as $$
  select
    t.type_id,
    t.name,
    t.group_id,
    t.category_id,
    char_length(btrim(q))::real / char_length(t.name) as coverage
  from public.sde_published_type t
  where btrim(q) <> ''
    and t.name ilike '%' || replace(replace(replace(btrim(q), '\', '\\'), '%', '\%'), '_', '\_') || '%'
  order by coverage desc, char_length(t.name), t.type_id
  limit least(greatest(lim, 1), 1000)
$$;

create or replace function public.sde_search_system(q text, lim int default 25)
returns table (system_id bigint, name text, security real, coverage real)
language sql
stable
set search_path = ''
as $$
  select
    s.system_id,
    s.name,
    s.security,
    char_length(btrim(q))::real / char_length(s.name) as coverage
  from public.sde_kspace_system s
  where btrim(q) <> ''
    and s.name ilike '%' || replace(replace(replace(btrim(q), '\', '\\'), '%', '\%'), '_', '\_') || '%'
  order by coverage desc, char_length(s.name), s.system_id
  limit least(greatest(lim, 1), 1000)
$$;

grant execute on function public.sde_search_type(text, int) to anon, authenticated, service_role;
grant execute on function public.sde_search_system(text, int) to anon, authenticated, service_role;
