-- Phase 6 of the sharing layer's Revision 3 (docs/sharing-layer/06-supersede-mercenary-dens.md):
-- fold character_mercenary_den_share into the unified audience model. The
-- per-(registration, alliance) rows collapse to ONE row per registration
-- carrying the audience as arrays — same shape as character_asset_share and
-- character_fitting_share — with the subject staying "all my dens" (there is
-- no den_id; the share is a whole-category preference, as it always was).
-- Dens gain the corporation and link/public audiences as capabilities; the
-- /mercenary-dens picker keeps writing alliance lists only.
--
-- IMPORTANT SEMANTIC GUARD: under the unified model an EMPTY audience row
-- (null secret, both lists empty) means PUBLIC. "Shared with nobody" is
-- therefore represented by NO ROW — the picker deletes rather than writing an
-- empty row, and this migration can never create one (every old row names an
-- alliance).

-- 1. The new columns. `id` becomes the primary key so a future signed link
-- has a stable address, matching the other share tables.
alter table public.character_mercenary_den_share
  add column id uuid not null default gen_random_uuid(),
  add column corporation_ids bigint[] not null default '{}',
  add column alliance_ids bigint[] not null default '{}',
  add column secret text;

-- 2. Collapse to one row per registration, aggregating the alliances.
update public.character_mercenary_den_share s
set alliance_ids = g.allys
from (
  select registration_id,
         array_agg(distinct alliance_id) as allys,
         min(alliance_id) as keep_alliance
  from public.character_mercenary_den_share
  group by registration_id
) g
where s.registration_id = g.registration_id
  and s.alliance_id = g.keep_alliance;

delete from public.character_mercenary_den_share s
using (
  select registration_id, min(alliance_id) as keep_alliance
  from public.character_mercenary_den_share
  group by registration_id
) g
where s.registration_id = g.registration_id
  and s.alliance_id <> g.keep_alliance;

-- 3. The visibility helper reads the arrays through the shared matcher. Same
-- signature, so the widening policies on character_mercenary_den_over_time
-- and mercenary_den_enemy_intel are untouched.
create or replace function public.mercenary_den_shared_with_caller(reg_id uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.character_mercenary_den_share s
    where s.registration_id = reg_id
      and public.share_audience_matches(s.corporation_ids, s.alliance_ids, s.secret)
  );
$$;

-- 4. Audience-read policy moves to the array/anon form (load-bearing, as on
-- every share table). The old alliance_id policy must go before the column can.
drop policy "Alliance members read shares to their alliances" on public.character_mercenary_den_share;
create policy "Audience reads den shares aimed at them"
  on public.character_mercenary_den_share
  for select
  to anon, authenticated
  using (public.share_audience_matches(corporation_ids, alliance_ids, secret));

-- 5. The picker now edits the one row in place, so UPDATE joins the
-- per-command owner policies; with check repeats the predicate so a row can't
-- be re-pointed at someone else's registration.
create policy "Users update own den shares"
  on public.character_mercenary_den_share
  for update
  to authenticated
  using (
    registration_id in (select id from public.registration where user_id = (select auth.uid()))
  )
  with check (
    registration_id in (select id from public.registration where user_id = (select auth.uid()))
  );

grant select on public.character_mercenary_den_share to anon;
grant update on public.character_mercenary_den_share to authenticated;

-- 6. Retire the old shape: the (registration_id, alliance_id) key and the
-- alliance_id column give way to id as primary key + one row per registration.
alter table public.character_mercenary_den_share
  drop constraint character_mercenary_den_share_pkey;
drop index if exists character_mercenary_den_share_alliance_id_idx;
alter table public.character_mercenary_den_share
  drop column alliance_id,
  add primary key (id),
  add constraint character_mercenary_den_share_registration_key unique (registration_id);
