-- Soft-delete for enemy-den sightings: deleting a row now stamps deleted_at
-- instead of removing it, so the record is retained. The /mercenary-dens query
-- filters out rows where deleted_at is set.
alter table public.mercenary_den_enemy_intel add column if not exists deleted_at timestamptz;

-- The submitter soft-deletes by updating their own row's deleted_at, so they
-- need update (scoped the same way as the existing delete policy).
drop policy if exists "Authenticated soft-delete own enemy den intel" on public.mercenary_den_enemy_intel;
create policy "Authenticated soft-delete own enemy den intel"
  on public.mercenary_den_enemy_intel
  for update
  to authenticated
  using (created_by = (select auth.uid()))
  with check (created_by = (select auth.uid()));

grant update on public.mercenary_den_enemy_intel to authenticated;
