-- A character's deployed Mercenary Dens and their live status, from the
-- compatibility-date ESI endpoints /characters/{id}/structures/mercenary-dens
-- (+ per-den detail). Live table reconciled like character_order: each run
-- upserts every den the character currently fields (refreshing recorded_at)
-- and deletes rows left with an older recorded_at. Not SCD-2 —
-- development/anarchy amounts drift continuously; only current status matters.

create table public.character_mercenary_den (
  character_id uuid not null references public.registration(id) on delete cascade,
  den_id bigint not null,
  planet_id bigint not null,
  type_id bigint,
  state text,
  development_level text,
  development_amount bigint,
  anarchy_level text,
  anarchy_amount bigint,
  infomorphs bigint,
  reinforcement_end timestamptz,
  skyhook_id bigint,
  skyhook_corporation_id bigint,
  recorded_at timestamptz not null default now(),
  primary key (character_id, den_id)
);
create index character_mercenary_den_character_id_idx on public.character_mercenary_den (character_id);

alter table public.character_mercenary_den enable row level security;
create policy "Users read own mercenary dens"
  on public.character_mercenary_den
  for select
  to authenticated
  using (
    character_id in (
      select id from public.registration where user_id = (select auth.uid())
    )
  );

grant select on public.character_mercenary_den to authenticated;
grant all    on public.character_mercenary_den to service_role;
