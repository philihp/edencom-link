-- Shared corkboard for hand-submitted intel on enemy-owned Mercenary Dens seen
-- reinforced. ESI has no feed for another corp's dens, so any authenticated
-- user can post a sighting. Visibility piggybacks on
-- character_mercenary_den_share: a submitter always sees their own reports,
-- and a corpmate sees them exactly when the submitter shares their Mercenary
-- Den data with that corp (see 20260716040000_mercenary_den_share_per_user.sql,
-- applied after this one, for that table's restructuring). Rendered as its own
-- table on /mercenary-dens, below the Temperate planets table.
create table if not exists public.mercenary_den_enemy_intel (
  id bigint generated always as identity primary key,
  system text not null,
  planet text not null,
  owner text not null,
  alliance text,
  reinforcement_end timestamptz,
  notes text,
  reported_by text not null,
  created_by uuid not null references auth.users(id) on delete cascade default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists mercenary_den_enemy_intel_reinforcement_end_idx
  on public.mercenary_den_enemy_intel (reinforcement_end);

alter table public.mercenary_den_enemy_intel enable row level security;

drop policy if exists "Users read own enemy den intel" on public.mercenary_den_enemy_intel;
create policy "Users read own enemy den intel"
  on public.mercenary_den_enemy_intel
  for select
  to authenticated
  using (created_by = (select auth.uid()));

drop policy if exists "Authenticated insert own enemy den intel" on public.mercenary_den_enemy_intel;
create policy "Authenticated insert own enemy den intel"
  on public.mercenary_den_enemy_intel
  for insert
  to authenticated
  with check (created_by = (select auth.uid()));

drop policy if exists "Authenticated delete own enemy den intel" on public.mercenary_den_enemy_intel;
create policy "Authenticated delete own enemy den intel"
  on public.mercenary_den_enemy_intel
  for delete
  to authenticated
  using (created_by = (select auth.uid()));

grant select, insert, delete on public.mercenary_den_enemy_intel to authenticated;
grant all                    on public.mercenary_den_enemy_intel to service_role;
