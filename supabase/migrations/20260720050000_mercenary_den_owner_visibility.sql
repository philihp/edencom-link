-- Make the owner identity of *shared* Mercenary Den data visible to the
-- corpmates it's shared with. Both fixes below have the same root cause:
-- registration RLS only ever exposes a user's OWN rows, so anything that has to
-- read another user's registration on behalf of a corpmate silently finds
-- nothing.
--
--   1. The /mercenary-dens table labelled a shared den's owner "Corpmate"
--      instead of the character's name, because the page can only resolve
--      registration ids it owns.
--   2. The "Corpmates read shared enemy den intel" policy joined
--      public.registration inside a USING clause that runs as the querying
--      corpmate; registration RLS hid the reporter's rows, so the corp-sharing
--      branch never matched and enemy-den intel was effectively private.
--      (The friendly-den policy avoided this by reading only the
--      corpmate-readable character_mercenary_den_share table.)
--
-- Both are fixed with SECURITY DEFINER helpers that bypass registration RLS but
-- expose only the minimum: public EVE identity (name, character_id) for dens the
-- caller can already see, and a boolean for intel visibility. Neither leaks
-- user_id / which characters share an account.

-- Own + shared-to-caller registrations, resolved to their public EVE identity
-- only (name + character_id — never user_id). "Shared to caller" mirrors the
-- corp-sharing policy on character_mercenary_den_over_time, so a registration is
-- returned exactly when the caller can already see that owner's dens.
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
    and (
      r.user_id = auth.uid()
      or exists (
        select 1
        from public.character_mercenary_den_share sh
        where sh.character_id = r.id
          and sh.corporation_id in (
            select c.corporation_id
            from public.registration c
            where c.user_id = auth.uid() and c.corporation_id is not null
          )
      )
    );
$$;

grant execute on function public.mercenary_den_owner_names(uuid[]) to authenticated;

-- True when target_user shares their Mercenary Den data with a corporation the
-- caller owns a character in — the same character_mercenary_den_share preference
-- that gates real dens, but computed under definer rights so it can read the
-- reporter's registrations (which registration RLS would otherwise hide from the
-- caller). Returns only a boolean, so it can't be used to enumerate a user's
-- characters or corps.
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
    join public.character_mercenary_den_share sh on sh.character_id = r.id
    where r.user_id = target_user
      and sh.corporation_id in (
        select c.corporation_id
        from public.registration c
        where c.user_id = auth.uid() and c.corporation_id is not null
      )
  );
$$;

grant execute on function public.user_shares_dens_with_caller(uuid) to authenticated;

-- Rewrite the enemy-intel corp-sharing policy to go through the definer helper
-- instead of joining registration directly (which RLS blocked).
drop policy if exists "Corpmates read shared enemy den intel" on public.mercenary_den_enemy_intel;
create policy "Corpmates read shared enemy den intel"
  on public.mercenary_den_enemy_intel
  for select
  to authenticated
  using (public.user_shares_dens_with_caller(created_by));
