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
drop function if exists public.character_asset_snapshot_at(uuid[], timestamptz) cascade;
drop function if exists public.character_industry_jobs(uuid[], boolean)  cascade;
drop function if exists public.character_orders(uuid[])                  cascade;
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
drop table if exists public.character_order               cascade;
drop table if exists public.character_industry_job        cascade;
drop table if exists public.character_affiliation         cascade;
drop table if exists public.industry_system_index cascade;
drop table if exists public.corp_structure_rig   cascade;
drop table if exists public.corp_structure       cascade;
drop table if exists public.corp_wallet_journal  cascade;
drop table if exists public.corp_wallet_transaction cascade;
-- Pre-existing gap: corp_asset_over_time/corp_asset and corp_industry_job
-- never had drop statements, so re-running this file against an
-- already-reset database failed on them.
drop view  if exists public.corp_asset                cascade;
drop table if exists public.corp_asset_over_time      cascade;
drop table if exists public.corp_industry_job         cascade;
drop view  if exists public.corp_blueprint            cascade;
drop table if exists public.corp_blueprint_over_time  cascade;
drop table if exists public.character_location        cascade;
drop view  if exists public.character_clone            cascade;
drop table if exists public.character_clone_over_time  cascade;
drop table if exists public.character_clone_state      cascade;
drop table if exists public.character_implant          cascade;
drop view  if exists public.character_ship              cascade;
drop table if exists public.character_ship_over_time    cascade;
drop table if exists public.universe_name        cascade;
drop table if exists public.universe_structure   cascade;
drop table if exists public.invite_code          cascade;
drop table if exists public.watched_system       cascade;
drop table if exists public.user_settings        cascade;
drop table if exists public.refresh_task         cascade;
drop table if exists public.shared_asset_token   cascade;
drop table if exists public.heartbeat            cascade;
drop table if exists public.esi_etag             cascade;
drop table if exists public.token                cascade;
drop table if exists public.registration         cascade;

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
create table public.token (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  character_id uuid not null references public.registration(id) on delete cascade,
  access_token text not null,
  refresh_token text not null,
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  scope text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (character_id)
);
create index token_character_id_idx on public.token (character_id);
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
-- last_seen_at on the open row is extended every run the item is seen
-- unchanged. The `character_asset` view below exposes just the live rows.
create table public.character_asset_over_time (
  id bigint generated always as identity primary key,
  item_id bigint not null,
  character_id uuid not null references public.registration(id) on delete cascade,
  type_id bigint not null,
  location_id bigint,
  location_flag text,
  location_type text,
  quantity bigint,
  is_singleton boolean,
  is_blueprint_copy boolean,
  is_current boolean not null default true,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  -- Player-assigned name (ship/container custom name) for singleton items; null
  -- otherwise. Kept last to match the add-column migration's column order.
  name text
);
create index character_asset_over_time_character_id_idx on public.character_asset_over_time (character_id);
-- At most one live row per item; also the conflict target the extract relies on.
create unique index character_asset_over_time_current_item_idx on public.character_asset_over_time (item_id) where is_current;
-- Time-travel lookups walking an item's version history.
create index character_asset_over_time_item_id_idx on public.character_asset_over_time (item_id, last_seen_at desc);

alter table public.character_asset_over_time enable row level security;
create policy "Users read own assets"
  on public.character_asset_over_time
  for select
  to authenticated
  using (
    character_id in (
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

-- item search (/asset/search): every current item whose type_id is in
-- `type_ids`, with its root location and nested-item count. Seeded from just
-- the matched items (rather than every asset, like the two functions above),
-- so this stays cheap even though the caller can pass up to 100 type ids.
create or replace function public.character_asset_search(type_ids bigint[])
returns table (
  item_id bigint,
  character_id uuid,
  type_id bigint,
  quantity bigint,
  is_singleton boolean,
  name text,
  location_flag text,
  root_location_id bigint,
  root_location_type text,
  contents bigint
)
language sql
stable
as $$
  with recursive parent_of as (
    select distinct on (item_id) item_id, location_id, location_type
    from public.character_asset_over_time
    order by item_id, is_current desc, last_seen_at desc
  ),
  matched as (
    select a.item_id, a.character_id, a.type_id, a.quantity, a.is_singleton, a.name,
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
    m.character_id,
    m.type_id,
    m.quantity,
    m.is_singleton,
    m.name,
    m.location_flag,
    r.root_location_id,
    r.root_location_type,
    coalesce(ct.contents, 0) as contents
  from matched m
  join roots r on r.start_item = m.item_id
  left join contents ct on ct.ancestor = m.item_id;
$$;

grant execute on function public.character_asset_location_summary()        to authenticated;
grant execute on function public.character_asset_location_contents(bigint) to authenticated;
grant execute on function public.character_asset_search(bigint[])          to authenticated;

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

-- ── character_blueprint_over_time ─────────────────────────────────────────
-- ESI /characters/{id}/blueprints/, written by the character-blueprints job.
-- SCD Type 2 history of a character's blueprints, mirroring
-- character_asset_over_time: is_current=true rows form the current snapshot,
-- last_seen_at is bumped each run for unchanged blueprints, and a new row is
-- inserted when anything tracked changes (old row's is_current set false).
-- quantity is -1 for an original (BPO), -2 for a copy (BPC), or the stack size
-- for multiple BPOs stacked together; runs is -1 for a BPO (unlimited) or the
-- runs remaining on a BPC. ESI's blueprint payload has no location_type
-- (unlike assets), so that column isn't tracked here.
create table public.character_blueprint_over_time (
  id bigint generated always as identity primary key,
  item_id bigint not null,
  character_id uuid not null references public.registration(id) on delete cascade,
  type_id bigint not null,
  location_id bigint,
  location_flag text,
  quantity bigint,
  material_efficiency smallint,
  time_efficiency smallint,
  runs integer,
  is_current boolean not null default true,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index character_blueprint_over_time_character_id_idx on public.character_blueprint_over_time (character_id);
-- At most one live row per item; also the conflict target the extract relies on.
create unique index character_blueprint_over_time_current_item_idx on public.character_blueprint_over_time (item_id) where is_current;
-- Time-travel lookups walking an item's version history.
create index character_blueprint_over_time_item_id_idx on public.character_blueprint_over_time (item_id, last_seen_at desc);

alter table public.character_blueprint_over_time enable row level security;
create policy "Users read own blueprints"
  on public.character_blueprint_over_time
  for select
  to authenticated
  using (
    character_id in (
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
        'character_name',      r.name
      )
      order by b.item_id
    ),
    '[]'::json
  )
  from public.character_blueprint b
  join public.registration r on r.id = b.character_id
  where b.character_id = any(character_ids);
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
  character_id uuid references public.registration(id) on delete cascade,
  corporation_id bigint,
  user_id uuid references auth.users(id) on delete cascade,
  owner_key text generated always as (coalesce(character_id::text, '') || '|' || coalesce(corporation_id::text, '')) stored,
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
create index heartbeat_character_id_idx on public.heartbeat (character_id);
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

-- The most recent completed heartbeat per job per owner (character, corp, or
-- whole-job), driving the freshness dots on /character/refresh. DISTINCT ON
-- over owner_key rather than the two nullable id columns so the account-wide
-- rows (both ids null) collapse to one row per job instead of being merged by
-- null-grouping quirks. Floored to the last 30 days to keep the sort bounded
-- as heartbeat grows — anything older is stale enough to read as "never".
-- SECURITY INVOKER (the default), so heartbeat's RLS scopes the rows to the
-- caller: their own characters, their corps, and the shared account-wide jobs.
create or replace function public.latest_heartbeats()
returns table (job text, character_id uuid, corporation_id bigint, ended_at timestamptz)
language sql
stable
as $$
  select distinct on (h.job, h.owner_key)
    h.job, h.character_id, h.corporation_id, h.ended_at
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
  character_id uuid not null references public.registration(id) on delete cascade,
  balance numeric(20, 2) not null,
  recorded_at timestamptz not null default now()
);
create index character_wallet_character_id_recorded_at_idx on public.character_wallet (character_id, recorded_at desc);

alter table public.character_wallet enable row level security;
create policy "Users read own wallets"
  on public.character_wallet
  for select
  to authenticated
  using (
    character_id in (
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
  character_id uuid not null references public.registration(id) on delete cascade,
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
create index character_wallet_transaction_character_id_date_idx on public.character_wallet_transaction (character_id, date desc);

alter table public.character_wallet_transaction enable row level security;
create policy "Users read own transactions"
  on public.character_wallet_transaction
  for select
  to authenticated
  using (
    character_id in (
      select id from public.registration where user_id = (select auth.uid())
    )
  );

grant select on public.character_wallet_transaction to authenticated;
grant all    on public.character_wallet_transaction to service_role;

-- ── character_order ───────────────────────────────────────────────────────
-- ESI /characters/{id}/orders/, written by the character-orders job: the
-- character's currently open market orders. The job keeps this a live
-- snapshot: each run upserts every open order and sweeps away that character's
-- rows it didn't see, which have since filled, expired or been cancelled.
-- is_buy is false for sell orders (ESI omits is_buy_order on those);
-- escrow/min_volume are buy-order-only, hence nullable.
create table public.character_order (
  order_id bigint primary key,
  character_id uuid not null references public.registration(id) on delete cascade,
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
  seen_at timestamptz not null default now()
);
create index character_order_character_id_issued_idx on public.character_order (character_id, issued desc);

alter table public.character_order enable row level security;
create policy "Users read own orders"
  on public.character_order
  for select
  to authenticated
  using (
    character_id in (
      select id from public.registration where user_id = (select auth.uid())
    )
  );

grant select on public.character_order to authenticated;
grant all    on public.character_order to service_role;

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

-- ── character_industry_job ────────────────────────────────────────────────
-- ESI /characters/{id}/industry/jobs/, written by the character-industry-jobs job.
create table public.character_industry_job (
  job_id bigint primary key,
  character_id uuid not null references public.registration(id) on delete cascade,
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
create index character_industry_job_character_id_end_date_idx on public.character_industry_job (character_id, end_date desc);

alter table public.character_industry_job enable row level security;
create policy "Users read own industry jobs"
  on public.character_industry_job
  for select
  to authenticated
  using (
    character_id in (
      select id from public.registration where user_id = (select auth.uid())
    )
  );

grant select on public.character_industry_job to authenticated;
grant all    on public.character_industry_job to service_role;

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

-- ── character_location ────────────────────────────────────────────────────
-- ESI /characters/{id}/location/, written by the character-location job. Live
-- current-state data — ESI only ever reports "where is the character right
-- now" — so this is a single upserted row per character, not a history table.
create table public.character_location (
  character_id uuid primary key references public.registration(id) on delete cascade,
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
    character_id in (
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
  character_id uuid not null references public.registration(id) on delete cascade,
  jump_clone_id bigint,
  is_home boolean not null default false,
  location_id bigint not null,
  location_type text,
  name text,
  implants jsonb not null default '[]'::jsonb,
  is_current boolean not null default true,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  -- Solar system the clone's station/structure sits in, resolved at extract
  -- time (null until resolvable). Kept last so a fresh reset matches the
  -- column order of migrated databases (the character_clone view is select *).
  system_id bigint
);
create index character_clone_over_time_character_id_idx on public.character_clone_over_time (character_id);
create unique index character_clone_over_time_current_jump_idx
  on public.character_clone_over_time (character_id, jump_clone_id) where is_current and not is_home;
create unique index character_clone_over_time_current_home_idx
  on public.character_clone_over_time (character_id) where is_current and is_home;

alter table public.character_clone_over_time enable row level security;
create policy "Users read own clones"
  on public.character_clone_over_time
  for select
  to authenticated
  using (
    character_id in (
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
  character_id uuid primary key references public.registration(id) on delete cascade,
  type_ids bigint[] not null default '{}',
  recorded_at timestamptz not null default now()
);

alter table public.character_implant enable row level security;
create policy "Users read own implants"
  on public.character_implant
  for select
  to authenticated
  using (
    character_id in (
      select id from public.registration where user_id = (select auth.uid())
    )
  );

grant select on public.character_implant to authenticated;
grant all    on public.character_implant to service_role;

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
  character_id uuid not null references public.registration(id) on delete cascade,
  ship_item_id bigint not null,
  ship_type_id bigint not null,
  ship_name text,
  is_current boolean not null default true,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index character_ship_over_time_character_id_idx on public.character_ship_over_time (character_id);
create unique index character_ship_over_time_current_idx
  on public.character_ship_over_time (character_id) where is_current;

alter table public.character_ship_over_time enable row level security;
create policy "Users read own ship"
  on public.character_ship_over_time
  for select
  to authenticated
  using (
    character_id in (
      select id from public.registration where user_id = (select auth.uid())
    )
  );

create view public.character_ship with (security_invoker = on) as
  select * from public.character_ship_over_time where is_current;

grant select on public.character_ship_over_time to authenticated;
grant select on public.character_ship           to authenticated;
grant all    on public.character_ship_over_time to service_role;

-- ── character_clone_state ──────────────────────────────────────────────────
-- Character-level fields from ESI /characters/{id}/clones/, written by the
-- character-clones job alongside the per-clone SCD rows: when the last clone
-- jump happened and when the home station was last changed. Live current-state
-- data, like character_location. "Next jump available" is derived as
-- last_clone_jump_date + 24h (conservative; Infomorph Synchronizing shortens
-- it, but reading the skill would need the esi-skills.read_skills.v1 scope).
create table public.character_clone_state (
  character_id uuid primary key references public.registration(id) on delete cascade,
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
    character_id in (
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
  profile_id bigint,
  name text,
  state text,
  fuel_expires timestamptz,
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

grant select on public.corp_structure to authenticated;
grant all    on public.corp_structure to service_role;

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
  character_id uuid not null references public.registration(id) on delete cascade,
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
create index corp_wallet_transaction_character_id_date_idx on public.corp_wallet_transaction (character_id, date desc);

alter table public.corp_wallet_transaction enable row level security;
create policy "Users read own corp transactions"
  on public.corp_wallet_transaction
  for select
  to authenticated
  using (
    character_id in (
      select id from public.registration where user_id = (select auth.uid())
    )
  );

grant select on public.corp_wallet_transaction to authenticated;
grant all    on public.corp_wallet_transaction to service_role;

-- ── corp_asset_over_time ──────────────────────────────────────────────────
-- ESI /corporations/{id}/assets/ (esi-assets.read_corporation_assets.v1),
-- written by the corp-assets job. SCD Type 2 history of a corporation's assets,
-- mirroring character_asset_over_time for per-character assets: is_current=true
-- rows form the current snapshot, last_seen_at is bumped each run for unchanged
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
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index corp_asset_over_time_corporation_id_idx on public.corp_asset_over_time (corporation_id);
-- At most one live row per item; also the conflict target the reconcile relies on.
create unique index corp_asset_over_time_current_item_idx on public.corp_asset_over_time (item_id) where is_current;
-- Time-travel lookups walking an item's version history.
create index corp_asset_over_time_item_id_idx on public.corp_asset_over_time (item_id, last_seen_at desc);

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
returns table (location_id bigint, location_type text, corporation_id bigint, stacks bigint)
language sql
stable
as $$
  with recursive parent_of as (
    -- One best-known parent per item the caller can see: the live row if there
    -- is one, otherwise the most recent historical sighting, so the walk can
    -- bridge a container that momentarily dropped out of the current snapshot.
    select distinct on (item_id) item_id, location_id, location_type
    from public.corp_asset_over_time
    order by item_id, is_current desc, last_seen_at desc
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
    count(*) as stacks
  from walk w
  where w.location_id is not null
    and not exists (select 1 from parent_of o where o.item_id = w.location_id)
  group by w.location_id, w.location_type, w.corporation_id;
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
  contents bigint
)
language sql
stable
as $$
  with recursive parent_of as (
    select distinct on (item_id) item_id, location_id, location_type
    from public.corp_asset_over_time
    order by item_id, is_current desc, last_seen_at desc
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
    coalesce(ct.contents, 0) as contents
  from matched m
  join roots r on r.start_item = m.item_id
  left join contents ct on ct.ancestor = m.item_id;
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
returns table (item_id bigint, type_id bigint, name text, location_id bigint, location_type text, depth int)
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
  select * from walk order by depth;
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

-- ── corp_blueprint_over_time ──────────────────────────────────────────────
-- ESI /corporations/{id}/blueprints/, written by the corp-blueprints job. SCD
-- Type 2 history of a corporation's blueprints, mirroring
-- character_blueprint_over_time for per-character blueprints: is_current=true
-- rows form the current snapshot, last_seen_at is bumped each run for
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
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index corp_blueprint_over_time_corporation_id_idx on public.corp_blueprint_over_time (corporation_id);
-- At most one live row per item; also the conflict target the extract relies on.
create unique index corp_blueprint_over_time_current_item_idx on public.corp_blueprint_over_time (item_id) where is_current;
-- Time-travel lookups walking an item's version history.
create index corp_blueprint_over_time_item_id_idx on public.corp_blueprint_over_time (item_id, last_seen_at desc);

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
        'type_id',             b.type_id
      )
      order by b.item_id
    ),
    '[]'::json
  )
  from public.corp_blueprint b
  where b.corporation_id in (
    select corporation_id from public.registration
    where id = any(character_ids) and corporation_id is not null
  );
$$;

grant execute on function public.corp_blueprints(uuid[]) to service_role;

-- ── corp_industry_job ─────────────────────────────────────────────────────
-- ESI /corporations/{id}/industry/jobs/ (esi-industry.read_corporation_jobs.v1),
-- written by the corp-industry-jobs job, once per corp per run. Same shape as
-- the per-character character_industry_job table plus corporation_id;
-- installer_id is the character who started the job.
create table public.corp_industry_job (
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
create index corp_industry_job_corporation_id_end_date_idx on public.corp_industry_job (corporation_id, end_date desc);

alter table public.corp_industry_job enable row level security;
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

-- /api/corp/jobs IMPORTDATA endpoint: the caller's corporation(s) industry
-- jobs, mirroring character_industry_jobs()'s shape for the per-character
-- endpoint. Returns json (not jsonb) so json_build_object's key order is
-- preserved for the sheet's columns, and a single scalar sidesteps PostgREST's
-- max-rows cap.
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
-- 'indexes' gates the /indexes page and nav link per-user.
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
  character_id uuid references public.registration(id) on delete cascade,
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
