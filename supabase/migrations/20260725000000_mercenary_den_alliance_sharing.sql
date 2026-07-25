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
-- with one of theirs, and sharing is ON unless the owner explicitly opts out
-- (mercenary_den_share_opt_out). Corporation is honoured alongside alliance so
-- an alliance-less corp still shares internally rather than the feature
-- silently doing nothing.
--
-- The old opt-in rows describe a preference that no longer exists (and
-- preserving them would mean defaulting almost everyone to "not shared", the
-- opposite of the intent), so character_mercenary_den_share is dropped rather
-- than migrated.

-- Dropped before the table it reads, and before the definer helpers below are
-- replaced with bodies that no longer reference it.
drop policy if exists "Corpmates read shared mercenary dens" on public.character_mercenary_den_over_time;

-- ── mercenary_den_share_opt_out ──────────────────────────────────────────────
-- The inverse of the old share table: one row = "this user does NOT share their
-- Mercenary Den data with their corp/alliance". Absence means shared, which is
-- what makes the new default on without backfilling a row per account. Keyed by
-- auth user (not registration) because the preference covers everything a user
-- contributes — every character's dens plus their enemy-den intel, which is
-- attributed to the user, not a character.
create table if not exists public.mercenary_den_share_opt_out (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.mercenary_den_share_opt_out enable row level security;

-- A user manages only their own row. Other users' opt-outs are read by the
-- SECURITY DEFINER helper below, which bypasses this policy — no one needs to
-- see who else has opted out.
create policy "Users read own den share opt-out"
  on public.mercenary_den_share_opt_out
  for select
  to authenticated
  using (user_id = (select auth.uid()));

create policy "Users set own den share opt-out"
  on public.mercenary_den_share_opt_out
  for insert
  to authenticated
  with check (user_id = (select auth.uid()));

create policy "Users clear own den share opt-out"
  on public.mercenary_den_share_opt_out
  for delete
  to authenticated
  using (user_id = (select auth.uid()));

grant select, insert, delete on public.mercenary_den_share_opt_out to authenticated;
grant all                    on public.mercenary_den_share_opt_out to service_role;

-- ── Visibility helper ────────────────────────────────────────────────────────
-- Every registration whose Mercenary Den data the caller may read: their own,
-- plus every registration in a corporation or alliance one of the caller's
-- characters belongs to, minus the ones whose owner opted out. SECURITY DEFINER
-- because registration RLS only ever exposes a user's own rows (and the opt-out
-- table only the caller's own), so the corp/alliance match can't be computed as
-- a plain join by the querying user. Returns registration ids only — never
-- user_id, so it can't be used to correlate someone's alts.
create or replace function public.mercenary_den_visible_registrations()
returns table (id uuid)
language sql
security definer
set search_path = public
stable
as $$
  with caller as (
    select r.corporation_id, c.alliance_id
    from public.registration r
    left join public.corporation c on c.corporation_id = r.corporation_id
    where r.user_id = auth.uid()
  )
  select r.id
  from public.registration r
  where r.user_id = auth.uid()
  union
  select r.id
  from public.registration r
  left join public.corporation c on c.corporation_id = r.corporation_id
  where (
      r.corporation_id in (select corporation_id from caller where corporation_id is not null)
      or c.alliance_id in (select alliance_id from caller where alliance_id is not null)
    )
    and not exists (
      select 1 from public.mercenary_den_share_opt_out o where o.user_id = r.user_id
    );
$$;

grant execute on function public.mercenary_den_visible_registrations() to authenticated;

-- Now resolves owner identity for own + corp/alliance-visible registrations,
-- matching the new den policy exactly (a den's owner is nameable precisely when
-- the den itself is readable).
create or replace function public.mercenary_den_owner_names(reg_ids uuid[])
returns table (id uuid, name text, character_id bigint)
language sql
security definer
set search_path = public
stable
as $$
  select r.id, r.name, r.character_id
  from public.registration r
  where r.id = any(reg_ids)
    and r.id in (select v.id from public.mercenary_den_visible_registrations() v);
$$;

-- Enemy-den intel follows the same audience as real dens: readable when any of
-- the reporter's characters is visible to the caller under the rule above.
create or replace function public.user_shares_dens_with_caller(target_user uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.registration r
    where r.user_id = target_user
      and r.id in (select v.id from public.mercenary_den_visible_registrations() v)
  );
$$;

-- ── Den policy ───────────────────────────────────────────────────────────────
-- Additive/permissive, OR'd with "Users read own mercenary dens" (which stays
-- as the owner's own path, independent of the helper). The status table's
-- policy reads through this table, so it widens along with it.
create policy "Alliance members read shared mercenary dens"
  on public.character_mercenary_den_over_time
  for select
  to authenticated
  using (
    character_id in (select v.id from public.mercenary_den_visible_registrations() v)
  );

-- Renamed for the new audience; the body is unchanged (the helper it calls is
-- what changed).
drop policy if exists "Corpmates read shared enemy den intel" on public.mercenary_den_enemy_intel;
create policy "Alliance members read shared enemy den intel"
  on public.mercenary_den_enemy_intel
  for select
  to authenticated
  using (public.user_shares_dens_with_caller(created_by));

drop table if exists public.character_mercenary_den_share cascade;
