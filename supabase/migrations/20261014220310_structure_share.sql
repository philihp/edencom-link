-- corp_structure_share: sharing layer phase 12, PR B
-- (docs/sharing-layer/12-structure-share.md). A structure's owning
-- corporation shares the structure's details — the corp_structure row and its
-- fitted rigs — the standard Revision 3 way (corporations, alliances, a signed
-- link, everyone) and, new for this subject, with the people who build there:
-- everyone is_tenant_of() says has had an industry job at the structure in the
-- last 30 days (structure_tenant, PR A; the window per migration
-- 20261008050729).
--
-- This is also the CUTOVER from the two hard-coded "Alliance members read corp
-- structures / corp structure rigs" policies to share rows. Parity on the day:
-- every corporation in corp_structure gets one SEEDED row (structure_id null =
-- every structure it owns, now and later) whose alliance_ids the
-- corp-structures extract keeps equal to the corporation's current alliance —
-- so the grant stays as dynamic as the policy it replaces. A seeded row whose
-- corporation is in no alliance names nobody and is deliberately NOT public:
-- see the predicate below. The first director edit clears seeded_default and
-- from then on the arrays pin specific ids like every other Revision 3 row.
--
-- A share never opens corp_structure_status (fuel, profile), the wallet
-- journal or the owner's own jobs. Rollback: docs/sharing-layer/rollback-structure-share.sql.

-- ── 1. seed-once bookkeeping on the corporation ────────────────────────────
-- Stamped when the extract (or this migration) seeds the default row. A
-- director who deletes the seeded row has opted out and is never re-seeded:
-- the extract seeds only while this is null AND the corp has no share row.
alter table public.corporation
  add column if not exists structure_share_seeded_at timestamptz;

-- ── 2. the share table ─────────────────────────────────────────────────────
create table public.corp_structure_share (
  id uuid primary key default gen_random_uuid(),
  -- Grantor: the corporation that owns the structure (corp_structure.corporation_id).
  corporation_id bigint not null,
  -- Subject. Null = every structure this corporation owns, now and later. Only
  -- the seeded default and the /structure alliance toggle use null; the
  -- dialog edits one structure.
  structure_id bigint,
  -- (a) (b) (c) as on every Revision 3 share table.
  corporation_ids bigint[] not null default '{}',
  alliance_ids    bigint[] not null default '{}',
  secret text,
  -- (e) NEW: everyone who has had a job at the structure in the last 30 days
  -- (is_tenant_of). Per structure only: never true on a null-subject row.
  tenants boolean not null default false,
  -- True on the row the migration/extract seeded; cleared by the first
  -- director edit. While true the extract keeps alliance_ids equal to the
  -- corporation's current alliance, and the row matches ONLY through
  -- alliance_ids — never as "fully public" when that array is empty.
  seeded_default boolean not null default false,
  -- Audit: which registration saved it last (a director's character).
  updated_by uuid references public.registration (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (structure_id is not null or not tenants),
  -- A seeded row carries nothing but its alliance grant.
  check (not seeded_default or (secret is null and corporation_ids = '{}' and not tenants)),
  unique nulls not distinct (corporation_id, structure_id)
);

alter table public.corp_structure_share enable row level security;

-- ── 3. the one audience predicate ──────────────────────────────────────────
-- Does this share row reach the caller? Three paths, composed: the standard
-- audience matcher (corporations, alliances, fully public = the row naming no
-- one); the tenants flag against is_tenant_of(); and, for a SEEDED row, its
-- alliance list alone — a seeded row with an empty alliance_ids (the corp left
-- its alliance) must match nobody, where share_audience_matches() would read
-- that same state as "everyone". Invoker rights; the policies on the share
-- table and on both subject tables all go through it so they cannot drift.
create or replace function public.structure_share_matches(
  structure_id bigint,
  corporation_ids bigint[],
  alliance_ids bigint[],
  secret text,
  tenants boolean,
  seeded_default boolean
)
returns boolean
language sql
stable
set search_path = public
as $$
  select case
    when seeded_default then alliance_ids && array(select public.my_alliance_ids())
    -- A tenants row names someone, so it is never the fully-public state that
    -- share_audience_matches() reads an empty audience as.
    when tenants then
      corporation_ids && array(select public.my_corporation_ids())
      or alliance_ids && array(select public.my_alliance_ids())
      or (structure_id is not null and public.is_tenant_of(structure_id))
    else public.share_audience_matches(corporation_ids, alliance_ids, secret)
  end;
$$;

grant execute on function public.structure_share_matches(bigint, bigint[], bigint[], text, boolean, boolean)
  to authenticated, service_role;

-- ── 4. policies on the share table ─────────────────────────────────────────
-- Directors of the owning corporation manage it. "Director" is observed
-- capability (corp_job_access, job = 'corp-structures'): a registration that
-- fetched this corporation's structures proved a Station Manager token, the
-- same line the fuel policy draws. with check repeats the predicate so a row
-- can't be re-pointed at another corporation, and pins updated_by to one of
-- the caller's own characters.
create policy "Directors manage structure shares"
  on public.corp_structure_share
  for all
  to authenticated
  using (
    exists (
      select 1
      from public.corp_job_access a
      join public.registration r on r.id = a.registration_id
      where a.corporation_id = corp_structure_share.corporation_id
        and a.job = 'corp-structures'
        and r.user_id = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1
      from public.corp_job_access a
      join public.registration r on r.id = a.registration_id
      where a.corporation_id = corp_structure_share.corporation_id
        and a.job = 'corp-structures'
        and r.user_id = (select auth.uid())
    )
    and (
      updated_by is null
      or updated_by in (select id from public.registration where user_id = (select auth.uid()))
    )
  );

-- LOAD-BEARING, as on every Revision 3 table: the widening policies below run
-- as the viewer and can only match share rows this policy shows them. A
-- tenant grant is per structure (the check constraint above), so the tenancy
-- branch never has to ask "tenant of any structure of this corporation",
-- which would mean reading corp_structure from inside a policy — the very
-- access being granted. Signed-out viewers of a public or linked structure go
-- through the service-role path in src/app/structure/access.ts, so no anon
-- grant here.
create policy "Audience reads structure shares"
  on public.corp_structure_share
  for select
  to authenticated
  using (
    public.structure_share_matches(structure_id, corporation_ids, alliance_ids, secret, tenants, seeded_default)
  );

grant select, insert, update, delete on public.corp_structure_share to authenticated;
grant all                            on public.corp_structure_share to service_role;

-- ── 5. widening policies on the subject tables ─────────────────────────────
-- Additive — OR'd with the own-corps policies, which stay. A share covers the
-- named structure, or every structure of the corporation when its subject is
-- null. corp_structure_status keeps its directors-only policy untouched.
create policy "Audience reads shared corp structures"
  on public.corp_structure
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.corp_structure_share s
      where s.corporation_id = corp_structure.corporation_id
        and (s.structure_id is null or s.structure_id = corp_structure.structure_id)
        and public.structure_share_matches(
          corp_structure.structure_id, s.corporation_ids, s.alliance_ids, s.secret, s.tenants, s.seeded_default
        )
    )
  );

create policy "Audience reads shared corp structure rigs"
  on public.corp_structure_rig
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.corp_structure_share s
      where s.corporation_id = corp_structure_rig.corporation_id
        and (s.structure_id is null or s.structure_id = corp_structure_rig.structure_id)
        and public.structure_share_matches(
          corp_structure_rig.structure_id, s.corporation_ids, s.alliance_ids, s.secret, s.tenants, s.seeded_default
        )
    )
  );

-- ── 6. the seeded alliance default ─────────────────────────────────────────
-- One null-subject row per corporation that owns a scanned structure, naming
-- its current alliance (or nobody, when it has none — the extract fills that
-- in the day the corp joins one, which is what the dropped policy did
-- implicitly). Stamped on the corporation so the extract never re-seeds a
-- corp whose director later opts out by deleting the row.
insert into public.corp_structure_share (corporation_id, structure_id, alliance_ids, seeded_default)
select
  s.corporation_id,
  null,
  case when c.alliance_id is null then '{}'::bigint[] else array[c.alliance_id] end,
  true
from (select distinct corporation_id from public.corp_structure) s
left join public.corporation c on c.corporation_id = s.corporation_id
on conflict (corporation_id, structure_id) do nothing;

update public.corporation c
set structure_share_seeded_at = now()
where c.structure_share_seeded_at is null
  and c.corporation_id in (select distinct corporation_id from public.corp_structure);

-- Parity, proved before the old policies go: every corporation in
-- corp_structure has its seeded row, and every seeded row of a corporation in
-- an alliance names exactly that alliance. Aborts the migration otherwise.
do $$
declare
  missing bigint;
  wrong bigint;
begin
  select count(*) into missing
  from (select distinct corporation_id from public.corp_structure) s
  where not exists (
    select 1 from public.corp_structure_share sh
    where sh.corporation_id = s.corporation_id and sh.structure_id is null and sh.seeded_default
  );
  if missing > 0 then
    raise exception 'structure share cutover: % corporation(s) in corp_structure have no seeded share row', missing;
  end if;

  select count(*) into wrong
  from public.corp_structure_share sh
  join public.corporation c on c.corporation_id = sh.corporation_id
  where sh.seeded_default
    and sh.structure_id is null
    and c.alliance_id is not null
    and sh.alliance_ids <> array[c.alliance_id];
  if wrong > 0 then
    raise exception 'structure share cutover: % seeded row(s) do not name the corporation''s alliance', wrong;
  end if;
end $$;

-- ── 7. drop the hard-coded alliance policies ───────────────────────────────
drop policy if exists "Alliance members read corp structures" on public.corp_structure;
drop policy if exists "Alliance members read corp structure rigs" on public.corp_structure_rig;
