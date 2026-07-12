-- Character's currently-piloted ship (ESI /characters/{id}/ship/), used to
-- tag the character's current ship in a station's asset listing — otherwise
-- it's indistinguishable from any other ship parked there. Which ship (and
-- its player-given name) changes over a character's life, so this mirrors
-- the character_asset_over_time / character_clone_over_time SCD Type 2
-- pattern rather than being a plain live upsert.

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
