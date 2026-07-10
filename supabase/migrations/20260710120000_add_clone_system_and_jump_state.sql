-- Clone jump cooldown timestamps and per-clone solar system.
--
-- The /characters/{id}/clones/ payload also carries two character-level
-- timestamps (last_clone_jump_date, last_station_change_date) that the
-- character-clones job previously discarded; store them as a live
-- current-state row per character (like character_location /
-- character_implant). "Next jump available" is derived in the UI as
-- last_clone_jump_date + 24h (conservative: Infomorph Synchronizing shortens
-- it, but reading the skill would need another ESI scope).
--
-- Each clone row also gains system_id: the solar system its station/structure
-- sits in, resolved at extract time, so "which character has a clone
-- closest to system X" can be answered from the database alone.

-- ── character_clone_over_time.system_id ───────────────────────────────────
alter table public.character_clone_over_time
  add column system_id bigint;

-- select * re-expands on replace, picking up the appended column.
create or replace view public.character_clone with (security_invoker = on) as
  select * from public.character_clone_over_time where is_current;

-- ── character_clone_state ──────────────────────────────────────────────────
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
