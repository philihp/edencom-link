-- eve-hangar's own schema, isolated from any other app on the shared Supabase
-- project. Apply with `psql ... -f hangar.sql` (or paste into the SQL editor),
-- then add "hangar" to Settings → API → Exposed schemas in the Supabase
-- dashboard so PostgREST will route `.schema('hangar')` queries to it.

create schema if not exists hangar;

grant usage on schema hangar to anon, authenticated, service_role;
alter default privileges in schema hangar
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema hangar
  grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema hangar
  grant all on functions to anon, authenticated, service_role;

-- Rename the `character` table to `registration` and realign every relationship
-- that pointed at it. Idempotent and guarded so it is a no-op on a fresh install
-- (the create statements below already produce the `registration` shape) and on
-- re-runs. A plain rename keeps foreign keys, index contents, and dependent policy
-- expressions pointing at the renamed objects automatically; these steps only
-- realign the leftover identifiers (table, columns, indexes, constraint, policy).
-- This must run before the create-if-not-exists statements below, otherwise an
-- existing deployment would get a second, empty `registration` table.
do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'hangar' and table_name = 'character' and table_type = 'BASE TABLE'
  ) then
    alter table hangar.character rename to registration;
  end if;

  -- The table's own index and policy keep their old names through a table rename.
  alter index if exists hangar.character_user_id_idx rename to registration_user_id_idx;
  alter index if exists hangar.character_corporation_id_idx rename to registration_corporation_id_idx;
  if exists (
    select 1 from pg_policies
    where schemaname = 'hangar' and tablename = 'registration'
      and policyname = 'Users manage own characters'
  ) then
    alter policy "Users manage own characters" on hangar.registration
      rename to "Users manage own registrations";
  end if;

  -- Repoint the uuid foreign keys that referenced hangar.character(id). The plain
  -- column rename keeps each FK and its dependent index/policy pointing at the
  -- renamed table; only the column identifier needs realigning. (The bigint EVE
  -- character ids -- registration.character_id, character_corp, completed_character_id,
  -- client_id -- are a different concept and are intentionally left untouched.)
  if exists (select 1 from information_schema.columns
             where table_schema = 'hangar' and table_name = 'token' and column_name = 'character_id') then
    alter table hangar.token rename column character_id to registration_id;
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema = 'hangar' and table_name = 'asset_over_time' and column_name = 'character_id') then
    alter table hangar.asset_over_time rename column character_id to registration_id;
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema = 'hangar' and table_name = 'wallet' and column_name = 'character_id') then
    alter table hangar.wallet rename column character_id to registration_id;
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema = 'hangar' and table_name = 'market_transaction' and column_name = 'character_id') then
    alter table hangar.market_transaction rename column character_id to registration_id;
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema = 'hangar' and table_name = 'industry_job' and column_name = 'character_id') then
    alter table hangar.industry_job rename column character_id to registration_id;
  end if;

  -- Realign the dependent indexes and the token uniqueness constraint.
  alter index if exists hangar.token_character_id_idx rename to token_registration_id_idx;
  alter index if exists hangar.asset_over_time_character_id_idx rename to asset_over_time_registration_id_idx;
  alter index if exists hangar.wallet_character_id_recorded_at_idx rename to wallet_registration_id_recorded_at_idx;
  alter index if exists hangar.market_transaction_character_id_date_idx rename to market_transaction_registration_id_date_idx;
  alter index if exists hangar.industry_job_character_id_end_date_idx rename to industry_job_registration_id_end_date_idx;
  if exists (
    select 1 from pg_constraint
    where conname = 'token_character_id_key' and connamespace = 'hangar'::regnamespace
  ) then
    alter table hangar.token rename constraint token_character_id_key to token_registration_id_key;
  end if;
end $$;

create table if not exists hangar.registration (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  owner text not null,
  name text not null,
  character_id bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, owner)
);
create index if not exists registration_user_id_idx on hangar.registration (user_id);

alter table hangar.registration enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'hangar' and tablename = 'registration'
      and policyname = 'Users manage own registrations'
  ) then
    create policy "Users manage own registrations"
      on hangar.registration
      for all
      to authenticated
      using (user_id = (select auth.uid()))
      with check (user_id = (select auth.uid()));
  end if;
end $$;

create table if not exists hangar.token (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  registration_id uuid not null references hangar.registration(id) on delete cascade,
  access_token text not null,
  refresh_token text not null,
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  scope text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (registration_id)
);
create index if not exists token_registration_id_idx on hangar.token (registration_id);
create index if not exists token_user_id_idx on hangar.token (user_id);

alter table hangar.token enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'hangar' and tablename = 'token'
      and policyname = 'Users manage own tokens'
  ) then
    create policy "Users manage own tokens"
      on hangar.token
      for all
      to authenticated
      using (user_id = (select auth.uid()))
      with check (user_id = (select auth.uid()));
  end if;
end $$;

-- Assets are stored as a slowly changing dimension (SCD type 2) in
-- asset_over_time: each row is a versioned snapshot of one item's state. When the
-- hourly extract sees an item whose tracked attributes (location, quantity, ...)
-- differ from its current row, that row is closed (is_current = false) and a new
-- row is inserted, so the full history is retained and holdings can be
-- reconstructed at any past time. last_seen_at on the open row is extended every
-- run the item is seen unchanged; once the item changes or disappears, its row's
-- last_seen_at marks the last time that version was observed. The `asset` view
-- below exposes just the live rows.

-- Existing deployments imported assets into a table literally named `asset`;
-- rename it out of the way so `asset` can become the current-only view.
do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'hangar' and table_name = 'asset' and table_type = 'BASE TABLE'
  ) then
    alter table hangar.asset rename to asset_over_time;
  end if;
end $$;

create table if not exists hangar.asset_over_time (
  id bigint generated always as identity primary key,
  item_id bigint not null,
  registration_id uuid not null references hangar.registration(id) on delete cascade,
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
create index if not exists asset_over_time_registration_id_idx on hangar.asset_over_time (registration_id);
-- At most one live row per item; also the conflict target the extract relies on.
create unique index if not exists asset_over_time_current_item_idx on hangar.asset_over_time (item_id) where is_current;
-- Time-travel lookups walking an item's version history.
create index if not exists asset_over_time_item_id_idx on hangar.asset_over_time (item_id, last_seen_at desc);

-- Evolve existing deployments to the SCD shape above.
alter table hangar.asset_over_time add column if not exists is_current    boolean     not null default true;
alter table hangar.asset_over_time add column if not exists first_seen_at timestamptz not null default now();
alter table hangar.asset_over_time add column if not exists last_seen_at  timestamptz not null default now();
do $$
begin
  -- Swap the item_id primary key for a surrogate id so one item can have many
  -- historical rows.
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'hangar' and table_name = 'asset_over_time' and column_name = 'id'
  ) then
    alter table hangar.asset_over_time drop constraint if exists asset_pkey;
    alter table hangar.asset_over_time add column id bigint generated always as identity;
    alter table hangar.asset_over_time add primary key (id);
  end if;
end $$;

alter table hangar.asset_over_time enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'hangar' and tablename = 'asset_over_time' and policyname = 'Users read own assets'
  ) then
    create policy "Users read own assets"
      on hangar.asset_over_time
      for select
      to authenticated
      using (
        registration_id in (
          select id from hangar.registration where user_id = (select auth.uid())
        )
      );
  end if;
end $$;

-- Live snapshot of assets. security_invoker keeps the underlying RLS in force for
-- the querying (authenticated) role rather than running as the view owner.
create or replace view hangar.asset with (security_invoker = on) as
  select * from hangar.asset_over_time where is_current;

-- Explicit grants on the tables we just created. `alter default privileges`
-- above only applies to tables created by the role that ran the statement,
-- so this belt-and-suspenders grant ensures PostgREST's `authenticated` /
-- `anon` / `service_role` roles can actually reach these tables. Re-runnable.
grant select, insert, update, delete on hangar.registration    to authenticated;
grant select, insert, update, delete on hangar.token           to authenticated;
-- The view runs with the invoker's rights, so authenticated needs select on the
-- underlying table for the `asset` view to resolve (RLS still scopes the rows).
grant select                          on hangar.asset_over_time to authenticated;
grant select                          on hangar.asset           to authenticated;
grant all on hangar.registration, hangar.token, hangar.asset_over_time to service_role;

create table if not exists hangar.heartbeat (
  id uuid primary key default gen_random_uuid(),
  job text not null,
  ran_at timestamptz not null default now()
);
create index if not exists heartbeat_ran_at_idx
  on hangar.heartbeat (ran_at desc);

alter table hangar.heartbeat enable row level security;
grant all on hangar.heartbeat to service_role;

alter table hangar.registration add column if not exists character_id bigint;

create table if not exists hangar.wallet (
  id uuid primary key default gen_random_uuid(),
  registration_id uuid not null references hangar.registration(id) on delete cascade,
  balance numeric(20, 2) not null,
  recorded_at timestamptz not null default now()
);
create index if not exists wallet_registration_id_recorded_at_idx
  on hangar.wallet (registration_id, recorded_at desc);

alter table hangar.wallet enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'hangar' and tablename = 'wallet'
      and policyname = 'Users read own wallets'
  ) then
    create policy "Users read own wallets"
      on hangar.wallet
      for select
      to authenticated
      using (
        registration_id in (
          select id from hangar.registration where user_id = (select auth.uid())
        )
      );
  end if;
end $$;

grant select on hangar.wallet to authenticated;
grant all    on hangar.wallet to service_role;

-- Collapse hangar.token so there is at most one row per character, keeping the
-- row with the most scopes (ties broken by most recently updated).
delete from hangar.token
where id in (
  select id from (
    select id,
      row_number() over (
        partition by registration_id
        order by coalesce(array_length(scope, 1), 0) desc, updated_at desc
      ) as rn
    from hangar.token
  ) ranked
  where rn > 1
);

alter table hangar.token drop constraint if exists token_character_id_scope_key;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'token_registration_id_key'
      and conrelid = 'hangar.token'::regclass
  ) then
    alter table hangar.token add constraint token_registration_id_key unique (registration_id);
  end if;
end $$;

create table if not exists hangar.market_transaction (
  transaction_id bigint primary key,
  registration_id uuid not null references hangar.registration(id) on delete cascade,
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
create index if not exists market_transaction_registration_id_date_idx
  on hangar.market_transaction (registration_id, date desc);

alter table hangar.market_transaction enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'hangar' and tablename = 'market_transaction'
      and policyname = 'Users read own transactions'
  ) then
    create policy "Users read own transactions"
      on hangar.market_transaction
      for select
      to authenticated
      using (
        registration_id in (
          select id from hangar.registration where user_id = (select auth.uid())
        )
      );
  end if;
end $$;

grant select on hangar.market_transaction to authenticated;
grant all    on hangar.market_transaction to service_role;

create table if not exists hangar.industry_job (
  job_id bigint primary key,
  registration_id uuid not null references hangar.registration(id) on delete cascade,
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
create index if not exists industry_job_registration_id_end_date_idx
  on hangar.industry_job (registration_id, end_date desc);

alter table hangar.industry_job enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'hangar'
      and tablename = 'industry_job'
      and policyname = 'Users read own industry jobs'
  ) then
    create policy "Users read own industry jobs"
      on hangar.industry_job
      for select
      to authenticated
      using (
        registration_id in (
          select id from hangar.registration where user_id = (select auth.uid())
        )
      );
  end if;
end $$;

grant select on hangar.industry_job to authenticated;
grant all    on hangar.industry_job to service_role;

alter table hangar.registration add column if not exists corporation_id bigint;
create index if not exists registration_corporation_id_idx on hangar.registration (corporation_id);

create table if not exists hangar.corp_structure (
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
create index if not exists corp_structure_corporation_id_idx
  on hangar.corp_structure (corporation_id);

alter table hangar.corp_structure enable row level security;

create policy "Users read structures for own corps"
  on hangar.corp_structure
  for select
  to authenticated
  using (
    corporation_id in (
      select corporation_id from hangar.registration
      where user_id = (select auth.uid()) and corporation_id is not null
    )
  );

grant select on hangar.corp_structure to authenticated;
grant all    on hangar.corp_structure to service_role;

-- Rigs (and other fitted modules) installed in Upwell structures. ESI has no
-- dedicated structure-fitting endpoint; these come from the corporation assets
-- endpoint as items whose location_id is the structure_id and whose
-- location_flag is a RigSlot (RigSlot0..RigSlot7).
create table if not exists hangar.corp_structure_rig (
  structure_id bigint not null,
  location_flag text not null,
  type_id bigint not null,
  corporation_id bigint not null,
  updated_at timestamptz not null default now(),
  primary key (structure_id, location_flag)
);
create index if not exists corp_structure_rig_corporation_id_idx
  on hangar.corp_structure_rig (corporation_id);

alter table hangar.corp_structure_rig enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'hangar'
      and tablename = 'corp_structure_rig'
      and policyname = 'Users read structure rigs for own corps'
  ) then
    create policy "Users read structure rigs for own corps"
      on hangar.corp_structure_rig
      for select
      to authenticated
      using (
        corporation_id in (
          select corporation_id from hangar.registration
          where user_id = (select auth.uid()) and corporation_id is not null
        )
      );
  end if;
end $$;

grant select on hangar.corp_structure_rig to authenticated;
grant all    on hangar.corp_structure_rig to service_role;

create table if not exists hangar.corp_wallet_journal (
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
create index if not exists corp_wallet_journal_corp_date_idx
  on hangar.corp_wallet_journal (corporation_id, date desc);

alter table hangar.corp_wallet_journal enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'hangar'
      and tablename = 'corp_wallet_journal'
      and policyname = 'Users read journal for own corps'
  ) then
    create policy "Users read journal for own corps"
      on hangar.corp_wallet_journal
      for select
      to authenticated
      using (
        corporation_id in (
          select corporation_id from hangar.registration
          where user_id = (select auth.uid()) and corporation_id is not null
        )
      );
  end if;
end $$;

grant select on hangar.corp_wallet_journal to authenticated;
grant all    on hangar.corp_wallet_journal to service_role;

create table if not exists hangar.eve_name (
  id bigint primary key,
  name text not null,
  category text not null,
  resolved_at timestamptz not null default now()
);

alter table hangar.eve_name enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'hangar'
      and tablename = 'eve_name'
      and policyname = 'Authenticated read eve_name'
  ) then
    create policy "Authenticated read eve_name"
      on hangar.eve_name
      for select
      to authenticated
      using (true);
  end if;
end $$;

grant select on hangar.eve_name to authenticated;
grant all    on hangar.eve_name to service_role;

create table if not exists hangar.character_corp (
  character_id bigint primary key,
  corporation_id bigint not null,
  resolved_at timestamptz not null default now()
);

alter table hangar.character_corp enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'hangar'
      and tablename = 'character_corp'
      and policyname = 'Authenticated read character_corp'
  ) then
    create policy "Authenticated read character_corp"
      on hangar.character_corp
      for select
      to authenticated
      using (true);
  end if;
end $$;

grant select on hangar.character_corp to authenticated;
grant all    on hangar.character_corp to service_role;

-- Cache of player Upwell structure details (name, system) resolved from ESI's
-- authenticated /universe/structures endpoint by the structures job. Lets the
-- assets UI show a name/system for structures that aren't our own corp's (those
-- live in corp_structure) and aren't in the SDE.
create table if not exists hangar.structure (
  structure_id bigint primary key,
  name text,
  system_id bigint,
  type_id bigint,
  resolved_at timestamptz not null default now()
);

alter table hangar.structure enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'hangar'
      and tablename = 'structure'
      and policyname = 'Authenticated read structure'
  ) then
    create policy "Authenticated read structure"
      on hangar.structure
      for select
      to authenticated
      using (true);
  end if;
end $$;

grant select on hangar.structure to authenticated;
grant all    on hangar.structure to service_role;

-- Per-user preferences. `enabled_scopes` is the set of ESI OAuth scopes the
-- user has opted into requesting when they add a character; an absent row means
-- "request everything" (see src/app/character/userScopes.ts).
create table if not exists hangar.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  enabled_scopes text[] not null default '{}',
  updated_at timestamptz not null default now()
);

alter table hangar.user_settings enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'hangar'
      and tablename = 'user_settings'
      and policyname = 'Users manage own settings'
  ) then
    create policy "Users manage own settings"
      on hangar.user_settings
      for all
      to authenticated
      using (user_id = (select auth.uid()))
      with check (user_id = (select auth.uid()));
  end if;
end $$;

grant select, insert, update, delete on hangar.user_settings to authenticated;
grant all                            on hangar.user_settings to service_role;
