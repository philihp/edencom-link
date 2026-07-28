-- Ship fittings a character has saved in the game client. ESI
-- /characters/{id}/fittings/, written by the character-fittings job. SCD Type 2,
-- mirroring character_blueprint_over_time: one open (is_current) row per
-- (character, fitting), valid_until bumped when the fit is unchanged, a new
-- version opened when it's edited in place (same fitting_id, different modules),
-- and the open row closed when the fit is deleted. The character_fitting view is
-- the live snapshot.
--
-- owner_scope is 'character' for every row today: ESI exposes only personal
-- fittings — no corporation or alliance endpoint exists, and the response has no
-- folder discriminator (see docs/fittings.md). The column is here so ingesting
-- such an endpoint later writes a different value into this table rather than
-- needing a new one.
create table if not exists public.character_fitting_over_time (
  id bigint generated always as identity primary key,
  character_id uuid not null references public.registration(id) on delete cascade,
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
create index if not exists character_fitting_over_time_character_id_idx
  on public.character_fitting_over_time (character_id);
create unique index if not exists character_fitting_over_time_current_idx
  on public.character_fitting_over_time (character_id, fitting_id) where is_current;

alter table public.character_fitting_over_time enable row level security;

drop policy if exists "Users read own fittings" on public.character_fitting_over_time;
create policy "Users read own fittings"
  on public.character_fitting_over_time
  for select
  to authenticated
  using (
    character_id in (
      select id from public.registration where user_id = (select auth.uid())
    )
  );

create or replace view public.character_fitting with (security_invoker = on) as
  select * from public.character_fitting_over_time where is_current;

grant select on public.character_fitting_over_time to authenticated;
grant select on public.character_fitting           to authenticated;
grant all    on public.character_fitting_over_time to service_role;
