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

create table hangar.character (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  owner text not null,
  name text not null,
  character_id bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, owner)
);
create index character_user_id_idx on hangar.character (user_id);

alter table hangar.character enable row level security;

create policy "Users manage own characters"
  on hangar.character
  for all
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create table hangar.token (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  character_id uuid not null references hangar.character(id) on delete cascade,
  access_token text not null,
  refresh_token text not null,
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  scope text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (character_id)
);
create index token_character_id_idx on hangar.token (character_id);
create index token_user_id_idx on hangar.token (user_id);

alter table hangar.token enable row level security;

create policy "Users manage own tokens"
  on hangar.token
  for all
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create table hangar.asset (
  item_id bigint primary key,
  character_id uuid not null references hangar.character(id) on delete cascade,
  type_id bigint not null,
  location_id bigint,
  location_flag text,
  location_type text,
  quantity bigint,
  is_singleton boolean,
  is_blueprint_copy boolean,
  updated_at timestamptz not null default now()
);
create index asset_character_id_idx on hangar.asset (character_id);

alter table hangar.asset enable row level security;

create policy "Users read own assets"
  on hangar.asset
  for select
  to authenticated
  using (
    character_id in (
      select id from hangar.character where user_id = (select auth.uid())
    )
  );

-- Explicit grants on the tables we just created. `alter default privileges`
-- above only applies to tables created by the role that ran the statement,
-- so this belt-and-suspenders grant ensures PostgREST's `authenticated` /
-- `anon` / `service_role` roles can actually reach these tables. Re-runnable.
grant select, insert, update, delete on hangar.character to authenticated;
grant select, insert, update, delete on hangar.token     to authenticated;
grant select                          on hangar.asset    to authenticated;
grant all on hangar.character, hangar.token, hangar.asset to service_role;

create table if not exists hangar.heartbeat (
  id uuid primary key default gen_random_uuid(),
  job text not null,
  ran_at timestamptz not null default now()
);
create index if not exists heartbeat_ran_at_idx
  on hangar.heartbeat (ran_at desc);

alter table hangar.heartbeat enable row level security;
grant all on hangar.heartbeat to service_role;

alter table hangar.character add column if not exists character_id bigint;

create table if not exists hangar.wallet (
  id uuid primary key default gen_random_uuid(),
  character_id uuid not null references hangar.character(id) on delete cascade,
  balance numeric(20, 2) not null,
  recorded_at timestamptz not null default now()
);
create index if not exists wallet_character_id_recorded_at_idx
  on hangar.wallet (character_id, recorded_at desc);

alter table hangar.wallet enable row level security;

create policy "Users read own wallets"
  on hangar.wallet
  for select
  to authenticated
  using (
    character_id in (
      select id from hangar.character where user_id = (select auth.uid())
    )
  );

grant select on hangar.wallet to authenticated;
grant all    on hangar.wallet to service_role;

-- Collapse hangar.token so there is at most one row per character, keeping the
-- row with the most scopes (ties broken by most recently updated).
delete from hangar.token
where id in (
  select id from (
    select id,
      row_number() over (
        partition by character_id
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
    where conname = 'token_character_id_key'
      and conrelid = 'hangar.token'::regclass
  ) then
    alter table hangar.token add constraint token_character_id_key unique (character_id);
  end if;
end $$;

create table if not exists hangar.market_transaction (
  transaction_id bigint primary key,
  character_id uuid not null references hangar.character(id) on delete cascade,
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
create index if not exists market_transaction_character_id_date_idx
  on hangar.market_transaction (character_id, date desc);

alter table hangar.market_transaction enable row level security;

create policy "Users read own transactions"
  on hangar.market_transaction
  for select
  to authenticated
  using (
    character_id in (
      select id from hangar.character where user_id = (select auth.uid())
    )
  );

grant select on hangar.market_transaction to authenticated;
grant all    on hangar.market_transaction to service_role;

create table if not exists hangar.industry_job (
  job_id bigint primary key,
  character_id uuid not null references hangar.character(id) on delete cascade,
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
create index if not exists industry_job_character_id_end_date_idx
  on hangar.industry_job (character_id, end_date desc);

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
        character_id in (
          select id from hangar.character where user_id = (select auth.uid())
        )
      );
  end if;
end $$;

grant select on hangar.industry_job to authenticated;
grant all    on hangar.industry_job to service_role;

alter table hangar.character add column if not exists corporation_id bigint;
create index if not exists character_corporation_id_idx on hangar.character (corporation_id);

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
      select corporation_id from hangar.character
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
          select corporation_id from hangar.character
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
          select corporation_id from hangar.character
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
