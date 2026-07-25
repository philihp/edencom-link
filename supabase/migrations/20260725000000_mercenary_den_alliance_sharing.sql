-- Mercenary Den sharing: per-corporation opt-in → alliance-wide, on by default.
--
-- Sharing used to be an explicit per-corporation opt-in: a row in
-- character_mercenary_den_share meant "this character's owner shares their den
-- data (and their enemy-den intel) with that corporation", and with no rows a
-- user shared with nobody. Everyone who wanted sharing wanted it with their
-- whole alliance, and the picker was a step people forgot — so dens sat
-- invisible to exactly the fleet that needed to see them.
--
-- The audience is now derived rather than configured: a user's dens and intel
-- are visible to anyone whose characters share a corporation or an alliance
-- with one of theirs, and sharing is ON unless the owner explicitly opts out.
-- Corporation is honoured alongside alliance so an alliance-less corp still
-- shares internally rather than the feature silently doing nothing.
--
-- The old opt-in rows describe a preference that no longer exists (and
-- preserving them would mean defaulting almost everyone to "not shared", the
-- opposite of the intent), so character_mercenary_den_share is dropped rather
-- than migrated.
--
-- Everything here runs on INVOKER rights. The corp/alliance match reads the
-- world-readable character_directory (docs/sharing-layer/design.md's "identity
-- split": public identity keyed by registration_id, carrying no user_id) rather
-- than public.registration, which RLS would hide — so the SECURITY DEFINER
-- bridges added in 20260720050000 are dropped here instead of being rewritten.

-- Dropped before the table they read.
drop policy if exists "Corpmates read shared mercenary dens" on public.character_mercenary_den_over_time;
drop policy if exists "Corpmates read shared enemy den intel" on public.mercenary_den_enemy_intel;
drop function if exists public.mercenary_den_owner_names(uuid[]);
drop function if exists public.user_shares_dens_with_caller(uuid);

-- ── mercenary_den_share_opt_out ──────────────────────────────────────────────
-- The inverse of the old share table: one row = "this registration's dens are
-- NOT shared". Absence means shared, which is what makes the new default on
-- without backfilling a row per account.
--
-- Keyed by registration rather than by auth user for two reasons: the sharing
-- policies join through character_directory, which is keyed by registration and
-- deliberately carries no user_id; and it matches the per-character grantor
-- keying the sharing layer uses elsewhere. The UI still writes it as one
-- all-or-nothing choice (every one of the user's registrations at once).
--
-- Deliberately bare — registration_id and nothing else. A created_at would let
-- anyone watching this world-readable table correlate a user's alts by the
-- timestamp they were opted out together, which is exactly what the identity
-- split exists to prevent.
create table if not exists public.mercenary_den_share_opt_out (
  registration_id uuid primary key references public.registration(id) on delete cascade
);

alter table public.mercenary_den_share_opt_out enable row level security;

-- World-readable to authenticated users: the sharing policies below run as the
-- querying user and must be able to see *other* people's opt-outs to honour
-- them. All this exposes is "this character doesn't share its dens".
create policy "Authenticated read den share opt-outs"
  on public.mercenary_den_share_opt_out
  for select
  to authenticated
  using (true);

-- Writes are limited to the caller's own registrations.
create policy "Users set own den share opt-out"
  on public.mercenary_den_share_opt_out
  for insert
  to authenticated
  with check (
    registration_id in (select id from public.registration where user_id = (select auth.uid()))
  );

create policy "Users clear own den share opt-out"
  on public.mercenary_den_share_opt_out
  for delete
  to authenticated
  using (
    registration_id in (select id from public.registration where user_id = (select auth.uid()))
  );

grant select, insert, delete on public.mercenary_den_share_opt_out to authenticated;
grant all                    on public.mercenary_den_share_opt_out to service_role;

-- ── Audience helpers (INVOKER rights) ────────────────────────────────────────
-- Plain stable SQL functions, not SECURITY DEFINER: they read only what the
-- caller may already read — their own registrations (registration RLS exposes
-- exactly those) and the world-readable corporation/character_directory
-- tables. They exist to keep the policies below readable, not to widen access.

-- The corporations the caller has a character in.
create or replace function public.my_corporation_ids()
returns setof bigint
language sql
stable
as $$
  select r.corporation_id
  from public.registration r
  where r.user_id = (select auth.uid()) and r.corporation_id is not null;
$$;

-- The alliances those corporations belong to.
create or replace function public.my_alliance_ids()
returns setof bigint
language sql
stable
as $$
  select c.alliance_id
  from public.registration r
  join public.corporation c on c.corporation_id = r.corporation_id
  where r.user_id = (select auth.uid()) and c.alliance_id is not null;
$$;

-- True when the given registration shares its Mercenary Den data with the
-- caller: its public directory entry sits in one of the caller's corporations
-- or alliances, and its owner hasn't opted out. The single definition of the
-- audience — the den policy, the enemy-intel policy and the UI all go through
-- it, so they can't drift apart.
create or replace function public.mercenary_den_shared_with_caller(reg_id uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.character_directory d
    where d.registration_id = reg_id
      and (
        d.corporation_id in (select public.my_corporation_ids())
        or d.alliance_id in (select public.my_alliance_ids())
      )
      and not exists (
        select 1 from public.mercenary_den_share_opt_out o where o.registration_id = reg_id
      )
  );
$$;

grant execute on function public.my_corporation_ids() to authenticated;
grant execute on function public.my_alliance_ids() to authenticated;
grant execute on function public.mercenary_den_shared_with_caller(uuid) to authenticated;

-- ── Den policy ───────────────────────────────────────────────────────────────
-- Additive/permissive, OR'd with "Users read own mercenary dens" (which stays
-- as the owner's own path, independent of the directory). The status table's
-- policy reads through this table, so it widens along with it.
create policy "Alliance members read shared mercenary dens"
  on public.character_mercenary_den_over_time
  for select
  to authenticated
  using (public.mercenary_den_shared_with_caller(character_id));

-- ── Enemy intel: own it by character, not by auth user ───────────────────────
-- The corkboard was keyed only by created_by (an auth.users id), which no
-- invoker-rights policy can resolve to a corporation or alliance — mapping it
-- to characters needs public.registration, which RLS hides from everyone but
-- the owner. That's what forced the SECURITY DEFINER bridge. Attributing a
-- report to the reporting *character* instead lets the same
-- character_directory join that gates real dens gate intel too.
--
-- created_by stays as audit metadata and as the ownership fallback for rows
-- orphaned when a character is unlinked (reporter_id nulled): those stay
-- visible and deletable to their submitter, and invisible to everyone else.
alter table public.mercenary_den_enemy_intel
  add column if not exists reporter_id uuid references public.registration(id) on delete set null;

create index if not exists mercenary_den_enemy_intel_reporter_id_idx
  on public.mercenary_den_enemy_intel (reporter_id);

-- Backfill: the submitter's registration whose name matches the denormalized
-- reported_by (the UI has always stamped that from one of their characters),
-- else their main.
update public.mercenary_den_enemy_intel i
set reporter_id = coalesce(
  (select r.id from public.registration r
    where r.user_id = i.created_by and r.name = i.reported_by
    limit 1),
  (select r.id from public.registration r
    where r.user_id = i.created_by
    order by r.is_main desc, r.created_at
    limit 1)
)
where i.reporter_id is null;

drop policy if exists "Users read own enemy den intel" on public.mercenary_den_enemy_intel;
create policy "Users read own enemy den intel"
  on public.mercenary_den_enemy_intel
  for select
  to authenticated
  using (
    reporter_id in (select id from public.registration where user_id = (select auth.uid()))
    or (reporter_id is null and created_by = (select auth.uid()))
  );

create policy "Alliance members read shared enemy den intel"
  on public.mercenary_den_enemy_intel
  for select
  to authenticated
  using (public.mercenary_den_shared_with_caller(reporter_id));

-- A user can only post, soft-delete and delete intel attributed to one of their
-- own characters. created_by is still pinned to the caller so the orphan
-- fallback above can't be forged.
drop policy if exists "Authenticated insert own enemy den intel" on public.mercenary_den_enemy_intel;
create policy "Authenticated insert own enemy den intel"
  on public.mercenary_den_enemy_intel
  for insert
  to authenticated
  with check (
    created_by = (select auth.uid())
    and reporter_id in (select id from public.registration where user_id = (select auth.uid()))
  );

drop policy if exists "Authenticated delete own enemy den intel" on public.mercenary_den_enemy_intel;
create policy "Authenticated delete own enemy den intel"
  on public.mercenary_den_enemy_intel
  for delete
  to authenticated
  using (
    reporter_id in (select id from public.registration where user_id = (select auth.uid()))
    or (reporter_id is null and created_by = (select auth.uid()))
  );

drop policy if exists "Authenticated soft-delete own enemy den intel" on public.mercenary_den_enemy_intel;
create policy "Authenticated soft-delete own enemy den intel"
  on public.mercenary_den_enemy_intel
  for update
  to authenticated
  using (
    reporter_id in (select id from public.registration where user_id = (select auth.uid()))
    or (reporter_id is null and created_by = (select auth.uid()))
  )
  with check (
    reporter_id in (select id from public.registration where user_id = (select auth.uid()))
    or (reporter_id is null and created_by = (select auth.uid()))
  );

drop table if exists public.character_mercenary_den_share cascade;
