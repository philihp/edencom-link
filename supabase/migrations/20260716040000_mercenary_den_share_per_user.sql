-- Collapse character_mercenary_den_share from a per-den join (character_id,
-- den_id, corporation_id) to a per-user preference (character_id,
-- corporation_id). The UI has always treated it as all-or-nothing ("share ALL
-- my dens with X"), so den_id was redundant bookkeeping — and keeping it made
-- it impossible to reuse the same "I share my Mercenary Den data with corp X"
-- preference to gate mercenary_den_enemy_intel visibility, since a user with
-- no currently-deployed den had nowhere to record a share row.

drop policy if exists "Corpmates read shared mercenary dens" on public.character_mercenary_den_over_time;

alter table public.character_mercenary_den_share drop constraint if exists character_mercenary_den_share_pkey;

-- Collapse rows sharing (character_id, corporation_id) but differing only in
-- den_id down to one before dropping the column, to avoid a duplicate-key error
-- on the new primary key.
delete from public.character_mercenary_den_share a
  using public.character_mercenary_den_share b
  where a.character_id = b.character_id
    and a.corporation_id = b.corporation_id
    and a.ctid < b.ctid;

alter table public.character_mercenary_den_share
  drop column if exists den_id,
  add primary key (character_id, corporation_id);

create policy "Corpmates read shared mercenary dens"
  on public.character_mercenary_den_over_time
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.character_mercenary_den_share sh
      where sh.character_id = character_mercenary_den_over_time.character_id
        and sh.corporation_id in (
          select c.corporation_id from public.registration c
          where c.user_id = (select auth.uid()) and c.corporation_id is not null
        )
    )
  );

-- Corpmates read another user's enemy-den-intel reports exactly when that user
-- shares their Mercenary Den data with a corporation the caller owns a
-- character in. Additive/permissive: OR'd with "Users read own enemy den
-- intel" (from the previous migration).
drop policy if exists "Corpmates read shared enemy den intel" on public.mercenary_den_enemy_intel;
create policy "Corpmates read shared enemy den intel"
  on public.mercenary_den_enemy_intel
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.registration r
      join public.character_mercenary_den_share sh on sh.character_id = r.id
      where r.user_id = mercenary_den_enemy_intel.created_by
        and sh.corporation_id in (
          select c.corporation_id from public.registration c
          where c.user_id = (select auth.uid()) and c.corporation_id is not null
        )
    )
  );
