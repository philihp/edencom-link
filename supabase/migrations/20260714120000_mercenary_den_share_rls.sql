-- Enable row-level security on character_mercenary_den_share (previously
-- deliberately RLS-free). Two permissive SELECT policies:
--   1. corpmates read share rows aimed at a corporation they own a character in
--   2. owners read their own share rows (drives the /mercenary-dens corp
--      picker's checked state even if the character since left the corp)
-- Writes stay service-role only — authenticated has no write grants/policies.
--
-- The corp-sharing policy on character_mercenary_den_over_time reads this table
-- in its USING subquery, which runs as the querying user; policy 1 exposes
-- exactly the rows that subquery needs, so den visibility is unchanged.
alter table public.character_mercenary_den_share enable row level security;

drop policy if exists "Corpmates read shares to their corps" on public.character_mercenary_den_share;
create policy "Corpmates read shares to their corps"
  on public.character_mercenary_den_share
  for select
  to authenticated
  using (
    corporation_id in (
      select c.corporation_id from public.registration c
      where c.user_id = (select auth.uid()) and c.corporation_id is not null
    )
  );

drop policy if exists "Users read own den shares" on public.character_mercenary_den_share;
create policy "Users read own den shares"
  on public.character_mercenary_den_share
  for select
  to authenticated
  using (
    character_id in (
      select id from public.registration where user_id = (select auth.uid())
    )
  );
