-- A corporation's share stops working once the character it was shared on
-- behalf of leaves the corporation (or its account unlinks the character, which
-- nulls created_by). Until now the share was the corporation's alone and
-- outlived its author; the Share dialog now tells a member "If you lose access
-- to your corp, the share will be disabled", and this makes that true.
--
-- The row is NOT deleted — it stops matching. Any member still in the
-- corporation revives it by saving it again: every write now stamps the writer
-- into created_by, so the share is then made on their behalf.
--
-- Membership is read from character_directory, the world-readable identity
-- directory (registration is RLS-hidden from an audience, and the policies
-- below run as the audience). It follows the character-directory job, so a
-- departure takes effect within a day of it.

-- ── 1. the test ────────────────────────────────────────────────────────────
-- Invoker rights, reading only the world-readable directory. A null author is
-- never active.
create or replace function public.corp_share_author_active(corporation_id bigint, created_by uuid)
returns boolean
language sql
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.character_directory d
    where d.registration_id = corp_share_author_active.created_by
      and d.corporation_id = corp_share_author_active.corporation_id
  );
$$;

grant execute on function public.corp_share_author_active(bigint, uuid) to anon, authenticated;

-- ── 2. the audience reads only live shares ─────────────────────────────────
-- Load-bearing for everything that reads the share table as the audience:
-- GraphQL's sharedWithMe / includeShared, and the place policy "Audience reads
-- places a corp share names", whose subquery goes through this policy.
drop policy "Audience reads corp asset shares aimed at them" on public.corp_asset_share;

create policy "Audience reads corp asset shares aimed at them"
  on public.corp_asset_share
  for select
  to anon, authenticated
  using (
    public.share_audience_matches(corporation_ids, alliance_ids, secret)
    and public.corp_share_author_active(corporation_id, created_by)
  );

-- ── 3. the widening walk seeds only from live shares ───────────────────────
-- SECURITY DEFINER, so it reads the share table past RLS and needs the test
-- itself. Otherwise as 20261014161500_asset_place_share.sql left it.
create or replace function public.corp_shared_item_ids()
returns setof bigint
language sql
stable
security definer
set search_path = public
as $$
  with recursive
    matching_shares as (
      select s.corporation_id, s.item_id
      from corp_asset_share s
      where share_audience_matches(s.corporation_ids, s.alliance_ids, s.secret)
        and corp_share_author_active(s.corporation_id, s.created_by)
    ),
    walk (corporation_id, node, depth) as (
      select m.corporation_id, m.item_id, 0
      from matching_shares m
      union all
      -- A place share: the corporation's roots sitting at the place.
      select m.corporation_id, v.item_id, 1
      from matching_shares m
      join corp_asset_location l
        on l.location_id = m.item_id
       and l.corporation_id = m.corporation_id
      join corp_asset_version v
        on v.id = l.asset_id
       and v.is_current
      union all
      select w.corporation_id, c.item_id, w.depth + 1
      from walk w
      join corp_asset_version c
        on c.location_id = w.node
       and c.corporation_id = w.corporation_id
       and c.is_current
      -- Depth 16 of descent, matching the 16 climbs asset_ancestors() and
      -- asset_share_covers() cap at.
      where w.depth < 16
    )
  select distinct node from walk;
$$;

revoke execute on function public.corp_shared_item_ids() from public;
grant execute on function public.corp_shared_item_ids() to anon, authenticated;

-- ── 4. a write is made on the writer's behalf ──────────────────────────────
-- created_by must name one of the caller's own characters IN the grantor
-- corporation, on insert and on update alike — so editing a corpmate's share
-- takes it over, and a share whose author left comes back to life when a
-- member saves it.
drop policy "Members create own corp asset shares" on public.corp_asset_share;
drop policy "Members update own corp asset shares" on public.corp_asset_share;

create policy "Members create own corp asset shares"
  on public.corp_asset_share
  for insert
  to authenticated
  with check (
    corporation_id in (select public.my_corporation_ids())
    and created_by in (
      select r.id from public.registration r
      where r.user_id = (select auth.uid()) and r.corporation_id = corp_asset_share.corporation_id
    )
  );

create policy "Members update own corp asset shares"
  on public.corp_asset_share
  for update
  to authenticated
  using (corporation_id in (select public.my_corporation_ids()))
  with check (
    corporation_id in (select public.my_corporation_ids())
    and created_by in (
      select r.id from public.registration r
      where r.user_id = (select auth.uid()) and r.corporation_id = corp_asset_share.corporation_id
    )
  );
