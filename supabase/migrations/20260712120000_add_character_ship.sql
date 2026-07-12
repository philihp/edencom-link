-- Character's currently-piloted ship (ESI /characters/{id}/ship/), used to
-- exclude the character's current ship from a station's asset listing —
-- otherwise it's indistinguishable from any other ship parked there. Live
-- current-state data, like character_location: a single upserted row per
-- character rather than a history table.

create table public.character_ship (
  character_id uuid primary key references public.registration(id) on delete cascade,
  ship_item_id bigint not null,
  ship_type_id bigint not null,
  ship_name text,
  recorded_at timestamptz not null default now()
);

alter table public.character_ship enable row level security;
create policy "Users read own ship"
  on public.character_ship
  for select
  to authenticated
  using (
    character_id in (
      select id from public.registration where user_id = (select auth.uid())
    )
  );

grant select on public.character_ship to authenticated;
grant all    on public.character_ship to service_role;
