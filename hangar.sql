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
  unique (character_id, scope)
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
