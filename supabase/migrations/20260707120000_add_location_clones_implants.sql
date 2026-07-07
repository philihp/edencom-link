-- Character location, jump clones, and implants. Location and implants are
-- live current-state pulls (a single upserted row per character); clones use
-- the same SCD Type 2 pattern as character_asset_over_time /
-- character_blueprint_over_time since jump clones rarely change.

-- ── character_location ────────────────────────────────────────────────────
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
  last_seen_at timestamptz not null default now()
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
