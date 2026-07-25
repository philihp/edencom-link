-- Mercenary Den sharing: per-corporation → per-alliance.
--
-- Sharing stays an explicit opt-in — a row in character_mercenary_den_share
-- means "this character's owner shares their den data (and their enemy-den
-- intel) with that audience", and with no rows a user shares with nobody. What
-- changes is the audience: corporation becomes alliance. Everyone who wanted
-- sharing wanted it with their whole alliance, so picking corporations meant
-- either ticking every corp in the coalition or leaving fleetmates unable to see
-- dens they were expected to defend.
--
-- Existing shares are carried over rather than dropped: each (character,
-- corporation) row becomes (character, that corporation's alliance). Rows whose
-- shared-to corporation has no alliance have no audience to migrate to and are
-- removed — nothing else could preserve their intent, since the corporation is
-- no longer an audience the model can express.
--
-- Everything here runs on INVOKER rights. The share row names its own audience,
-- so the policies are plain joins against the alliances the caller has a
-- character in; owner identity comes from the world-readable character_directory
-- (docs/sharing-layer/design.md's "identity split": public identity keyed by
-- registration_id, carrying no user_id). That's what lets the SECURITY DEFINER
-- bridges added in 20260720050000 be dropped here rather than rewritten.

drop policy if exists "Corpmates read shared mercenary dens" on public.character_mercenary_den_over_time;
drop policy if exists "Corpmates read shared enemy den intel" on public.mercenary_den_enemy_intel;
drop policy if exists "Corpmates read shares to their corps" on public.character_mercenary_den_share;
drop function if exists public.mercenary_den_owner_names(uuid[]);
drop function if exists public.user_shares_dens_with_caller(uuid);

-- ── character_mercenary_den_share: corporation → alliance ────────────────────
alter table public.character_mercenary_den_share
  add column if not exists alliance_id bigint;

-- Carry every existing share over to the alliance of the corporation it pointed
-- at.
update public.character_mercenary_den_share sh
set alliance_id = c.alliance_id
from public.corporation c
where c.corporation_id = sh.corporation_id
  and c.alliance_id is not null
  and sh.alliance_id is null;

-- Shares aimed at a corporation with no alliance (or at a corporation the
-- directory has never seen) can't be expressed in the new model.
delete from public.character_mercenary_den_share where alliance_id is null;

-- Two of a user's characters could have been shared to different corporations in
-- the same alliance; those collapse to one row.
delete from public.character_mercenary_den_share a
  using public.character_mercenary_den_share b
  where a.character_id = b.character_id
    and a.alliance_id = b.alliance_id
    and a.ctid < b.ctid;

alter table public.character_mercenary_den_share drop constraint if exists character_mercenary_den_share_pkey;
drop index if exists public.character_mercenary_den_share_corporation_id_idx;

alter table public.character_mercenary_den_share
  drop column if exists corporation_id,
  alter column alliance_id set not null,
  add primary key (character_id, alliance_id);

create index if not exists character_mercenary_den_share_alliance_id_idx
  on public.character_mercenary_den_share (alliance_id);

-- ── Audience helpers (INVOKER rights) ────────────────────────────────────────
-- Plain stable SQL functions, not SECURITY DEFINER: they read only what the
-- caller may already read — their own registrations (registration RLS exposes
-- exactly those), the world-readable corporation table, and share rows the
-- policies below already expose. They exist to keep those policies readable, not
-- to widen access. Defined before the policies that call them, since a policy
-- expression is parsed and validated at creation time.

-- The alliances the caller has a character in — the audiences they can share
-- with, and the ones the picker offers.
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

-- True when the given registration shares its Mercenary Den data with an
-- alliance the caller has a character in. The single definition of the
-- audience — the den policy and the enemy-intel policy both go through it, so
-- they can't drift apart.
create or replace function public.mercenary_den_shared_with_caller(reg_id uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.character_mercenary_den_share sh
    where sh.character_id = reg_id
      and sh.alliance_id in (select public.my_alliance_ids())
  );
$$;

grant execute on function public.my_alliance_ids() to authenticated;
grant execute on function public.mercenary_den_shared_with_caller(uuid) to authenticated;

-- ── character_mercenary_den_share policies ───────────────────────────────────
-- Writes used to be service-role only (the picker went through the service
-- client). The audience is now something the caller can be checked against
-- directly, so they move to plain RLS on the caller's own registrations.
drop policy if exists "Users read own den shares" on public.character_mercenary_den_share;

-- Members read the share rows aimed at their alliances. This is also what keeps
-- the den/intel policies below working: their subquery over this table runs as
-- the querying user, and the only rows it needs are exactly the ones this policy
-- exposes.
create policy "Alliance members read shares to their alliances"
  on public.character_mercenary_den_share
  for select
  to authenticated
  using (alliance_id in (select public.my_alliance_ids()));

-- Owners always read their own share rows (this drives the picker's checked
-- state), even if the sharing character has since left that alliance — without
-- this, such a stale share would turn invisible to the very user who created it.
-- Permissive: OR'd with the alliance policy above.
create policy "Users read own den shares"
  on public.character_mercenary_den_share
  for select
  to authenticated
  using (
    character_id in (select id from public.registration where user_id = (select auth.uid()))
  );

create policy "Users create own den shares"
  on public.character_mercenary_den_share
  for insert
  to authenticated
  with check (
    character_id in (select id from public.registration where user_id = (select auth.uid()))
  );

create policy "Users remove own den shares"
  on public.character_mercenary_den_share
  for delete
  to authenticated
  using (
    character_id in (select id from public.registration where user_id = (select auth.uid()))
  );

grant select, insert, delete on public.character_mercenary_den_share to authenticated;
grant all                    on public.character_mercenary_den_share to service_role;

-- ── Den policy ───────────────────────────────────────────────────────────────
-- Additive/permissive, OR'd with "Users read own mercenary dens" (which stays as
-- the owner's own path, independent of any share row). The status table's policy
-- reads through this table, so it widens along with it.
create policy "Alliance members read shared mercenary dens"
  on public.character_mercenary_den_over_time
  for select
  to authenticated
  using (public.mercenary_den_shared_with_caller(character_id));

-- ── Enemy intel: own it by character, not by auth user ───────────────────────
-- The corkboard was keyed only by created_by (an auth.users id), which no
-- invoker-rights policy can match against a share row — mapping it to characters
-- needs public.registration, which RLS hides from everyone but the owner. That's
-- what forced the SECURITY DEFINER bridge. Attributing a report to the reporting
-- *character* instead lets the same share rows that gate real dens gate intel.
--
-- created_by stays as audit metadata and as the ownership fallback for rows
-- orphaned when a character is unlinked (reporter_id nulled): those stay visible
-- and deletable to their submitter, and invisible to everyone else.
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
