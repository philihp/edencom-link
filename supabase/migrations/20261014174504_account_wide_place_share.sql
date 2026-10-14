-- A character place share covers the whole ACCOUNT's character-owned items at
-- the place (docs/sharing-layer/15-place-share.md), not just the one
-- character's. The share row is unchanged — still keyed on one grantor
-- registration, the "anchor" — but a row now covers items held by any
-- registration of the anchor's account. A corporation's place share is
-- untouched: its grantor was always the corporation.
--
-- Two pieces, matching the two paths a recipient reads through:
--   1. asset_share_covers() collects the matching shares of every registration
--      on the item owner's account, not only the owner's own. This is safe for
--      item shares too: a walk climbs one owner's parent links, so it can only
--      reach an item of that owner, and a sibling's share names an item the
--      owner does not hold.
--   2. the place-read policy on character_asset_location widens the same way.
--      `registration` is RLS-hidden from a recipient, so the expansion from an
--      anchor to its account's registrations lives in a definer function, the
--      shape corp_shared_item_ids() has. It is argument-free, stable and
--      returns only (registration, place) pairs of shares already aimed at the
--      caller, evaluated once per query as a hashed subplan.

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
      where s.registration_id in (
              select r.id
              from public.registration r
              where r.user_id = (
                select o.user_id from public.registration o where o.id = asset_share_covers.registration
              )
            )
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

create or replace function public.shared_place_pairs()
returns table (registration_id uuid, location_id bigint)
language sql
stable
security definer
set search_path = public
as $$
  select sibling.id, s.item_id
  from character_asset_share s
  join public.registration anchor on anchor.id = s.registration_id
  join public.registration sibling on sibling.user_id = anchor.user_id
  where share_audience_matches(s.corporation_ids, s.alliance_ids, s.secret);
$$;

revoke execute on function public.shared_place_pairs() from public;
grant execute on function public.shared_place_pairs() to anon, authenticated;

drop policy "Audience reads places a share names" on public.character_asset_location;

create policy "Audience reads places a share names"
  on public.character_asset_location
  for select
  to anon, authenticated
  using (
    (registration_id, location_id) in (select p.registration_id, p.location_id from public.shared_place_pairs() p)
  );
