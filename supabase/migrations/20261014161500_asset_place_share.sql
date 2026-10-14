-- Place shares (docs/sharing-layer/15-place-share.md). A share's subject may
-- now be a PLACE — a station, a player structure, a solar system — as well as
-- an item. Nothing new is stored: character_asset_share/corp_asset_share
-- already key on a bare item_id, and a place share is a row whose item_id names
-- the place. What changes is what a row covers: the grantor's own items whose
-- root sits at that place, and everything inside them. Another owner's items at
-- the same place are never covered, because coverage is keyed on the grantor
-- (registration or corporation) exactly as before.
--
-- Three pieces, one per path a recipient reads through:
--   1. asset_share_covers() climbs past a root to the root's place, so a
--      character place share covers the grantor's roots there and their trees;
--   2. corp_shared_item_ids() also seeds its descent from the grantor
--      corporation's roots at a shared place;
--   3. the two place tables gain an audience policy for the place a share
--      names, so a recipient's view of a covered root reads its place — the
--      one the grantor chose to name — and "the items at this station" is a
--      plain location_id filter for them too. The place of a root the share
--      does not name stays owner-only.

-- ── 1. the character climb reaches the place ───────────────────────────────
-- The lateral step now takes the root's place when the version row has no
-- parent link, so the walk's last node is the place. The location row is pinned
-- to the grantor: a parent link only ever names an asset of the same owner, so
-- this can't change today's answers, but the place a walk reaches must be the
-- grantor's own rather than whatever the row happens to join.
create or replace function public.asset_share_covers(item bigint, registration uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with recursive
    matching_shares as (
      select s.item_id
      from character_asset_share s
      where s.registration_id = asset_share_covers.registration
        and asset_share_matches_caller(s.corporation_ids, s.alliance_ids, s.secret)
    ),
    walk (node, depth) as (
      select asset_share_covers.item, 0
      union all
      select parent.location_id, w.depth + 1
      from walk w
      cross join lateral (
        select coalesce(o.location_id, l.location_id) as location_id
        from character_asset_version o
        left join character_asset_location l
          on l.asset_id = o.id
         and l.registration_id = asset_share_covers.registration
        where o.item_id = w.node
        order by o.is_current desc, o.valid_until desc
        limit 1
      ) parent
      where w.depth < 16
        and parent.location_id is not null
        and exists (select 1 from matching_shares)
    )
  select exists (
    select 1
    from walk w
    join matching_shares m on m.item_id = w.node
  );
$$;

revoke execute on function public.asset_share_covers(bigint, uuid) from public;
grant execute on function public.asset_share_covers(bigint, uuid) to anon, authenticated;

-- ── 2. the corp descent also starts at a shared place's roots ──────────────
-- A second seed: the grantor corporation's current roots whose place is the
-- share's subject. They enter at depth 1, so the descent below a place share
-- reaches the same 16 levels under the subject a climb does.
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

-- ── 3. a recipient reads the place a share names ───────────────────────────
-- Uncorrelated on purpose: the planner turns `(owner, place) in (…)` into one
-- hashed subplan per query, so an owner reading their own hangar pays for one
-- small scan of the share table rather than an index probe per row. Invoker
-- rights: the subquery reads the share tables through their own audience
-- policies, which never touch the place tables, so nothing recurses.
--
-- The policy opens the place row of every version of a covered root, closed
-- ones included; the view joins it only to version rows the recipient can
-- read, and those are current-only, so the history stays shut there.
create policy "Audience reads places a share names"
  on public.character_asset_location
  for select
  to anon, authenticated
  using (
    (registration_id, location_id) in (
      select s.registration_id, s.item_id
      from public.character_asset_share s
      where public.share_audience_matches(s.corporation_ids, s.alliance_ids, s.secret)
    )
  );

create policy "Audience reads places a corp share names"
  on public.corp_asset_location
  for select
  to anon, authenticated
  using (
    (corporation_id, location_id) in (
      select s.corporation_id, s.item_id
      from public.corp_asset_share s
      where public.share_audience_matches(s.corporation_ids, s.alliance_ids, s.secret)
    )
  );
