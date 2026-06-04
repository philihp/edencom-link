-- Canonical schema for edencom-link, in the default `public` schema (PostgREST
-- exposes it out of the box, so there is no "Exposed schemas" dashboard step).
--
-- This file is the single source of truth and a full reset: it DROPs the app's
-- objects and recreates them from scratch. Re-running it WIPES existing data in
-- these tables. Apply with `psql ... -f schema.sql` or paste into the Supabase
-- SQL editor. There is no separate migrations system — to change the schema,
-- edit this file and re-run it.

-- ── Reset ──────────────────────────────────────────────────────────────────
-- Nuke any leftover from the previous `hangar` schema, then drop the app's
-- objects in `public`. CASCADE clears dependent foreign keys and the asset view.
drop schema if exists hangar cascade;

drop function if exists public.asset_location_summary()        cascade;
drop function if exists public.asset_location_contents(bigint) cascade;
drop view  if exists public.asset                cascade;
drop table if exists public.asset_over_time      cascade;
drop table if exists public.wallet               cascade;
drop table if exists public.market_transaction   cascade;
drop table if exists public.industry_job         cascade;
drop table if exists public.industry_system_index cascade;
drop table if exists public.corp_structure_rig   cascade;
drop table if exists public.corp_structure       cascade;
drop table if exists public.corp_wallet_journal  cascade;
drop table if exists public.eve_name             cascade;
drop table if exists public.character_corp       cascade;
drop table if exists public.structure            cascade;
drop table if exists public.user_settings        cascade;
drop table if exists public.heartbeat            cascade;
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

-- ── asset_over_time ───────────────────────────────────────────────────────
-- Assets as a slowly changing dimension (SCD type 2): each row is a versioned
-- snapshot of one item's state. When the hourly extract sees an item whose
-- tracked attributes (location, quantity, ...) differ from its current row,
-- that row is closed (is_current = false) and a new row inserted, so full
-- history is retained. last_seen_at on the open row is extended every run the
-- item is seen unchanged. The `asset` view below exposes just the live rows.
create table public.asset_over_time (
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
create index asset_over_time_character_id_idx on public.asset_over_time (character_id);
-- At most one live row per item; also the conflict target the extract relies on.
create unique index asset_over_time_current_item_idx on public.asset_over_time (item_id) where is_current;
-- Time-travel lookups walking an item's version history.
create index asset_over_time_item_id_idx on public.asset_over_time (item_id, last_seen_at desc);

alter table public.asset_over_time enable row level security;
create policy "Users read own assets"
  on public.asset_over_time
  for select
  to authenticated
  using (
    character_id in (
      select id from public.registration where user_id = (select auth.uid())
    )
  );

-- Live snapshot of assets. security_invoker keeps the underlying RLS in force
-- for the querying (authenticated) role rather than running as the view owner.
create view public.asset with (security_invoker = on) as
  select * from public.asset_over_time where is_current;

grant select on public.asset_over_time to authenticated;
grant select on public.asset           to authenticated;
grant all    on public.asset_over_time to service_role;

-- ── asset aggregation functions ───────────────────────────────────────────
-- Items nest (a module in a ship in a station), so the UI used to page every
-- live asset into Node and walk the location_id chains there — tens of
-- thousands of rows per request, which timed the pages out. These do the walk
-- in Postgres instead and return only the aggregate each page needs. Both are
-- SECURITY INVOKER (the default), so the asset view's RLS still scopes every
-- read to the caller's own characters. The depth caps guard against cycles.

-- assets index (/assets): for every root location (a station, structure or
-- solar system that isn't itself one of our items), the number of item stacks
-- there, split by the character that owns each stack. Each asset is climbed up
-- its location_id chain through items we also own until the parent isn't ours;
-- that parent is the root.
create or replace function public.asset_location_summary()
returns table (location_id bigint, location_type text, character_id uuid, stacks bigint)
language sql
stable
as $$
  with recursive walk as (
    select
      a.item_id       as start_item,
      a.character_id  as character_id,
      a.location_id   as location_id,
      a.location_type as location_type,
      1               as depth
    from public.asset a
    union all
    select
      w.start_item,
      w.character_id,
      p.location_id,
      p.location_type,
      w.depth + 1
    from walk w
    join public.asset p on p.item_id = w.location_id
    where w.depth < 64
  )
  select
    w.location_id,
    w.location_type,
    w.character_id,
    count(*) as stacks
  from walk w
  where w.location_id is not null
    and not exists (select 1 from public.asset o where o.item_id = w.location_id)
  group by w.location_id, w.location_type, w.character_id;
$$;

-- per-location page (/assets/[locationId]): for each item sitting directly in
-- `parent`, the number of items nested inside it (the whole subtree, excluding
-- the item itself).
create or replace function public.asset_location_contents(parent bigint)
returns table (item_id bigint, contents bigint)
language sql
stable
as $$
  with recursive descend as (
    select a.item_id as root_child, a.item_id as node, 1 as depth
    from public.asset a
    where a.location_id = parent
    union all
    select d.root_child, c.item_id, d.depth + 1
    from descend d
    join public.asset c on c.location_id = d.node
    where d.depth < 64
  )
  select root_child as item_id, count(*) - 1 as contents
  from descend
  group by root_child;
$$;

grant execute on function public.asset_location_summary()        to authenticated;
grant execute on function public.asset_location_contents(bigint) to authenticated;

-- /api/assets ImportJSON endpoint: the player's total inventory summed by item
-- type as of `at`, reconstructed from the SCD-2 history. A row counts when it had
-- started by `at` and was either still open then or is the current version (its
-- state extends forward past last_seen_at to now); a later version of an item
-- always starts after the prior one's last_seen_at, so at most one version per
-- item matches — no double counting. Aggregating in Postgres avoids paging tens
-- of thousands of raw rows into the serverless function (which timed it out). The
-- route calls this with the service role over the caller's own registration ids,
-- so it takes them as a parameter rather than leaning on RLS.
create or replace function public.asset_inventory_at(character_ids uuid[], as_of timestamptz)
returns table (type_id bigint, quantity bigint)
language sql
stable
as $$
  select a.type_id, sum(coalesce(a.quantity, 1))::bigint as quantity
  from public.asset_over_time a
  where a.character_id = any(character_ids)
    and a.first_seen_at <= as_of
    and (a.last_seen_at >= as_of or a.is_current)
  group by a.type_id;
$$;

grant execute on function public.asset_inventory_at(uuid[], timestamptz) to service_role;

-- ── heartbeat ─────────────────────────────────────────────────────────────
-- One row per scheduled-job run. Workflows write a 'start' step (stamps
-- started_at) and an 'end' step (stamps ended_at), both keyed on the GitHub
-- Actions run so they land on the same row. run_url links back to that run.
create table public.heartbeat (
  id uuid primary key default gen_random_uuid(),
  job text not null,
  run_id bigint,
  run_attempt integer,
  run_url text,
  started_at timestamptz,
  ended_at timestamptz,
  ran_at timestamptz not null default now()
);
-- Pairs the start/end steps of a single run onto one row. Local runs (no run
-- id) fall back to plain inserts, and Postgres keeps null keys distinct.
create unique index heartbeat_run_idx on public.heartbeat (job, run_id, run_attempt);
create index heartbeat_ran_at_idx on public.heartbeat (ran_at desc);
-- Lets the UI find a job's most recent completion with an index scan.
create index heartbeat_job_ended_at_idx on public.heartbeat (job, ended_at desc);

alter table public.heartbeat enable row level security;
create policy "Authenticated read heartbeat"
  on public.heartbeat
  for select
  to authenticated
  using (true);

grant select on public.heartbeat to authenticated;
grant all    on public.heartbeat to service_role;

-- ── wallet ────────────────────────────────────────────────────────────────
create table public.wallet (
  id uuid primary key default gen_random_uuid(),
  character_id uuid not null references public.registration(id) on delete cascade,
  balance numeric(20, 2) not null,
  recorded_at timestamptz not null default now()
);
create index wallet_character_id_recorded_at_idx on public.wallet (character_id, recorded_at desc);

alter table public.wallet enable row level security;
create policy "Users read own wallets"
  on public.wallet
  for select
  to authenticated
  using (
    character_id in (
      select id from public.registration where user_id = (select auth.uid())
    )
  );

grant select on public.wallet to authenticated;
grant all    on public.wallet to service_role;

-- ── market_transaction ────────────────────────────────────────────────────
create table public.market_transaction (
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
create index market_transaction_character_id_date_idx on public.market_transaction (character_id, date desc);

alter table public.market_transaction enable row level security;
create policy "Users read own transactions"
  on public.market_transaction
  for select
  to authenticated
  using (
    character_id in (
      select id from public.registration where user_id = (select auth.uid())
    )
  );

grant select on public.market_transaction to authenticated;
grant all    on public.market_transaction to service_role;

-- ── industry_job ──────────────────────────────────────────────────────────
create table public.industry_job (
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
create index industry_job_character_id_end_date_idx on public.industry_job (character_id, end_date desc);

alter table public.industry_job enable row level security;
create policy "Users read own industry jobs"
  on public.industry_job
  for select
  to authenticated
  using (
    character_id in (
      select id from public.registration where user_id = (select auth.uid())
    )
  );

grant select on public.industry_job to authenticated;
grant all    on public.industry_job to service_role;

-- ── corp_structure ────────────────────────────────────────────────────────
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
-- as items whose location_id is the structure_id and location_flag is a
-- RigSlot (RigSlot0..RigSlot7).
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
-- History of EVE's per-system industry cost indices, snapshotted each structures
-- run for every solar system we have a structure anchored in. Public ESI data
-- (/industry/systems/), so it's readable by everyone. Each row is one system /
-- activity (manufacturing, reaction, copying, invention, ...) and the recorded
-- cost index at recorded_at; the table is append-only so the indices' drift over
-- time can be charted.
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

-- ── eve_name ──────────────────────────────────────────────────────────────
-- Cache of resolved EVE id -> name/category lookups.
create table public.eve_name (
  id bigint primary key,
  name text not null,
  category text not null,
  resolved_at timestamptz not null default now()
);

alter table public.eve_name enable row level security;
create policy "Authenticated read eve_name"
  on public.eve_name
  for select
  to authenticated
  using (true);

grant select on public.eve_name to authenticated;
grant all    on public.eve_name to service_role;

-- ── character_corp ────────────────────────────────────────────────────────
create table public.character_corp (
  character_id bigint primary key,
  corporation_id bigint not null,
  resolved_at timestamptz not null default now()
);

alter table public.character_corp enable row level security;
create policy "Authenticated read character_corp"
  on public.character_corp
  for select
  to authenticated
  using (true);

grant select on public.character_corp to authenticated;
grant all    on public.character_corp to service_role;

-- ── structure ─────────────────────────────────────────────────────────────
-- Cache of player Upwell structure details (name, system) resolved from ESI's
-- authenticated /universe/structures endpoint by the structures job. Lets the
-- assets UI show a name/system for structures that aren't our own corp's
-- (those live in corp_structure).
create table public.structure (
  structure_id bigint primary key,
  name text,
  system_id bigint,
  type_id bigint,
  resolved_at timestamptz not null default now()
);

alter table public.structure enable row level security;
create policy "Authenticated read structure"
  on public.structure
  for select
  to authenticated
  using (true);

grant select on public.structure to authenticated;
grant all    on public.structure to service_role;

-- ── user_settings ─────────────────────────────────────────────────────────
-- Per-user preferences. `enabled_scopes` is the set of ESI OAuth scopes the
-- user has opted into requesting when they add a character; an absent row means
-- "request everything" (see src/app/character/userScopes.ts).
-- `api_token` is an opaque per-user secret the Google Sheets ImportJSON endpoint
-- (/api/assets) authenticates with — that request carries no Supabase session,
-- so the route looks the user up by this token (service role) and scopes the
-- results to their characters. Null until the user generates one in settings.
create table public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  enabled_scopes text[] not null default '{}',
  api_token text unique,
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
