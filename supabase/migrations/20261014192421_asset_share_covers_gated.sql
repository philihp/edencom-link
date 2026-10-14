-- Hotfix for 20261014174504_account_wide_place_share.sql, which took every
-- character asset read on production past the 8 s statement_timeout for
-- authenticated (the asset pages, character_asset_location_summary(),
-- character_asset_filter()) and so read as "no assets".
--
-- The widening policy on character_asset_version calls asset_share_covers()
-- for every candidate row the owner policy rejects — every OTHER owner's row
-- at the place being listed, or every other owner's row at all for the
-- hangar-wide summary. That is tens of thousands of definer calls per query,
-- and the no-share short circuit inside the function is what kept them
-- affordable: one probe of character_asset_share by the row's registration.
-- The account-wide expansion turned that one probe into a registration
-- lookup, a sibling scan and a semi-join per call, and the sum crossed the
-- timeout.
--
-- Fix: reject before calling. asset_sharing_registration_ids() answers once
-- per query — the shape corp_shared_item_ids() and shared_place_pairs() use,
-- argument-free, stable, security definer, evaluated into one hashed subplan
-- — with the registrations (anchor and account siblings) that have any share
-- aimed at the caller. The policy tests the row's registration against that
-- set first, so the per-row function runs only for rows of an account that
-- shares something with the caller, which for almost every row of almost
-- every query is no row at all. The function's own answer is unchanged.
--
-- A SQL AND evaluates in written order, and the function is given a high
-- cost so the planner never floats it ahead of the membership test.

create or replace function public.asset_sharing_registration_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select distinct sibling.id
  from character_asset_share s
  join public.registration anchor on anchor.id = s.registration_id
  join public.registration sibling on sibling.user_id = anchor.user_id
  where share_audience_matches(s.corporation_ids, s.alliance_ids, s.secret);
$$;

revoke execute on function public.asset_sharing_registration_ids() from public;
grant execute on function public.asset_sharing_registration_ids() to anon, authenticated;

alter function public.asset_share_covers(bigint, uuid) cost 10000;

drop policy "Audience reads shared assets" on public.character_asset_version;

create policy "Audience reads shared assets"
  on public.character_asset_version
  for select
  to anon, authenticated
  using (
    is_current
    and registration_id in (select public.asset_sharing_registration_ids())
    and public.asset_share_covers(item_id, registration_id)
  );
