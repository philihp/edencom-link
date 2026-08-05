-- Phase 5 of the sharing layer's Revision 3 (docs/sharing-layer/05-supersede-fittings.md):
-- fold character_fitting_share into the unified audience model. The per-level
-- rows ('corporation'/'alliance'/'public', one row each) become ONE row per
-- (registration_id, fitting_id) carrying the audience as arrays, plus a
-- nullable secret for signed links — the same shape as character_asset_share.
--
-- SEMANTIC SHIFT, deliberate: level='corporation' meant "whoever is CURRENTLY
-- in my corp", resolved live through the owner's character_directory row at
-- read time. The arrays pin SPECIFIC corporation/alliance ids instead (what
-- the share dialog's checkboxes express, and what the asset share does).
-- Backfilling the owner's current affiliation keeps today's audiences intact
-- at cut-over; the meaning changes from "my corp, wherever I go" to "this
-- corp". A membership-level row whose owner has no directory affiliation
-- cannot be honored under the new model and is DELETED rather than silently
-- widened (an empty audience means public here).

-- 1. The new columns.
alter table public.character_fitting_share
  add column corporation_ids bigint[] not null default '{}',
  add column alliance_ids bigint[] not null default '{}',
  add column secret text;

-- 2. Backfill each level row from the owner's affiliation at migration time.
update public.character_fitting_share s
set corporation_ids = case
      when s.level = 'corporation' and d.corporation_id is not null then array[d.corporation_id]
      else '{}'
    end,
    alliance_ids = case
      when s.level = 'alliance' and d.alliance_id is not null then array[d.alliance_id]
      else '{}'
    end
from public.character_directory d
where d.registration_id = s.registration_id;

-- Membership rows that couldn't be pinned (no directory row, or a directory
-- row without the needed affiliation): delete rather than widen to public.
delete from public.character_fitting_share
where (level = 'corporation' and corporation_ids = '{}')
   or (level = 'alliance' and alliance_ids = '{}');

-- 3. Collapse each (registration_id, fitting_id) group to one row. A public
-- level dominates (public already means everyone); otherwise the arrays merge.
with groups as (
  select registration_id, fitting_id,
         bool_or(level = 'public') as is_public,
         array_remove(array_agg(distinct corporation_ids[1]), null) as corp_ids,
         array_remove(array_agg(distinct alliance_ids[1]), null) as ally_ids,
         (min(id::text))::uuid as keep_id
  from public.character_fitting_share
  group by registration_id, fitting_id
)
update public.character_fitting_share s
set corporation_ids = case when g.is_public then '{}' else g.corp_ids end,
    alliance_ids    = case when g.is_public then '{}' else g.ally_ids end,
    secret = null
from groups g
where s.id = g.keep_id;

delete from public.character_fitting_share s
using (
  select registration_id, fitting_id, (min(id::text))::uuid as keep_id
  from public.character_fitting_share
  group by registration_id, fitting_id
) g
where s.registration_id = g.registration_id
  and s.fitting_id = g.fitting_id
  and s.id <> g.keep_id;

-- 4. The shared audience matcher every share table now goes through —
-- extracted from asset_share_matches_caller, which becomes a delegating
-- alias (kept because the asset policies and asset_share_covers() call it by
-- name). Invoker rights, like every helper in this layer. A link-only row
-- (secret set, lists empty) deliberately matches no one under RLS: signed
-- links are resolved at the app layer.
create or replace function public.share_audience_matches(
  corporation_ids bigint[], alliance_ids bigint[], secret text
)
returns boolean
language sql
stable
as $$
  select
    (secret is null and corporation_ids = '{}' and alliance_ids = '{}')
    or corporation_ids && array(select public.my_corporation_ids())
    or alliance_ids && array(select public.my_alliance_ids());
$$;

grant execute on function public.share_audience_matches(bigint[], bigint[], text) to anon, authenticated;

create or replace function public.asset_share_matches_caller(
  corporation_ids bigint[], alliance_ids bigint[], secret text
)
returns boolean
language sql
stable
as $$
  select public.share_audience_matches(corporation_ids, alliance_ids, secret);
$$;

-- 5. The fitting visibility helper reads the arrays instead of levels. Same
-- signature, so the widening policy on character_fitting_over_time ("Audience
-- reads shared fittings") is untouched. No character_directory join any more:
-- the audience is pinned on the row.
create or replace function public.fitting_shared_with_caller(registration_id uuid, fitting_id bigint)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.character_fitting_share s
    where s.registration_id = fitting_shared_with_caller.registration_id
      and s.fitting_id = fitting_shared_with_caller.fitting_id
      and public.share_audience_matches(s.corporation_ids, s.alliance_ids, s.secret)
  );
$$;

-- 6. Audience-read policy moves to the array/anon form (load-bearing, as on
-- every share table: audience matching runs as the querying user and can only
-- see rows this policy exposes).
drop policy "Audience reads fitting shares aimed at them" on public.character_fitting_share;
create policy "Audience reads fitting shares aimed at them"
  on public.character_fitting_share
  for select
  to anon, authenticated
  using (public.share_audience_matches(corporation_ids, alliance_ids, secret));

-- 7. Owners now edit the one row in place (the dialog), so UPDATE joins the
-- per-command policies; with check repeats the predicate so a row can't be
-- re-pointed at someone else's registration.
create policy "Users update own fitting shares"
  on public.character_fitting_share
  for update
  to authenticated
  using (
    registration_id in (select id from public.registration where user_id = (select auth.uid()))
  )
  with check (
    registration_id in (select id from public.registration where user_id = (select auth.uid()))
  );

grant select on public.character_fitting_share to anon;
grant update on public.character_fitting_share to authenticated;

-- 8. Retire the old shape: level and the never-used token placeholder go, and
-- the one-row-per-fit identity becomes a constraint.
drop index if exists character_fitting_share_fitting_idx;
alter table public.character_fitting_share
  drop column level,
  drop column token,
  add constraint character_fitting_share_registration_fitting_key unique (registration_id, fitting_id);
