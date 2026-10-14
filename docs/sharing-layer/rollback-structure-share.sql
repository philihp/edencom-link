-- Rollback for supabase/migrations/20261014220310_structure_share.sql
-- (sharing layer phase 12, PR B — the structure-share cutover).
--
-- NOT a migration: run it by hand only to undo the cutover, in ONE
-- transaction so a failure leaves nothing half done:
--
--   psql "$DATABASE_URL" --single-transaction -v ON_ERROR_STOP=1 -f docs/sharing-layer/rollback-structure-share.sql
--
-- It re-creates the two hard-coded alliance policies exactly as schema.sql
-- carried them before the cutover, drops the widening policies, the share
-- table and its predicate, and the seed-once stamp. Any share a director
-- saved after the cutover is lost with the table — the alliance grant it
-- replaced comes back for everyone, which is the pre-cutover state.

-- ── the widening policies and the table ────────────────────────────────────
drop policy if exists "Audience reads shared corp structures"     on public.corp_structure;
drop policy if exists "Audience reads shared corp structure rigs" on public.corp_structure_rig;
drop table if exists public.corp_structure_share;
drop function if exists public.structure_share_matches(bigint, bigint[], bigint[], text, boolean, boolean);
alter table public.corporation drop column if exists structure_share_seeded_at;

-- ── the two policies the cutover dropped, verbatim ─────────────────────────
create policy "Alliance members read corp structures"
  on public.corp_structure
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.corporation owner_corp
      where owner_corp.corporation_id = corp_structure.corporation_id
        and owner_corp.alliance_id is not null
        and owner_corp.alliance_id in (
          select member_corp.alliance_id
          from public.registration r
          join public.corporation member_corp on member_corp.corporation_id = r.corporation_id
          where r.user_id = (select auth.uid())
            and member_corp.alliance_id is not null
        )
    )
  );

create policy "Alliance members read corp structure rigs"
  on public.corp_structure_rig
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.corporation owner_corp
      where owner_corp.corporation_id = corp_structure_rig.corporation_id
        and owner_corp.alliance_id is not null
        and owner_corp.alliance_id in (
          select member_corp.alliance_id
          from public.registration r
          join public.corporation member_corp on member_corp.corporation_id = r.corporation_id
          where r.user_id = (select auth.uid())
            and member_corp.alliance_id is not null
        )
    )
  );
