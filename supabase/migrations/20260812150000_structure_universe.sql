-- Per-account structure universe (docs/structure-universe/design.md).
--
-- Four independent pieces, all additive except the two RLS changes at the end:
--   1. universe_structure gains the fields the new hourly directory job fills.
--   2. structure_favorite — per-user pinning, sorted to the top of /structure.
--   3. corp_job_access — which character proved it can pull which corp endpoint.
--   4. RLS: structure rigs open to the alliance, fuel narrows to directors.

-- ── 1. universe_structure directory columns ───────────────────────────────
-- owner_corporation_id comes back free on every /universe/structures/{id}
-- resolve and is present in EVE Ref's dump, so structure ownership no longer
-- needs a corp token to learn. is_public marks membership of ESI's public list
-- (a completely open ACL). source records which of the three feeds last wrote
-- the row, so precedence is explicit rather than last-write-wins: a name we
-- resolved ourselves with a real token outranks EVE Ref's copy.
alter table public.universe_structure
  add column if not exists owner_corporation_id bigint,
  add column if not exists is_public boolean not null default false,
  add column if not exists source text;

comment on column public.universe_structure.source is
  'Which feed last wrote this row: esi-token (resolved with docking access), everef, or public-list. Precedence order is esi-token > everef > public-list.';

-- ── 2. structure_favorite ─────────────────────────────────────────────────
-- Per-user pinned structures, sorted to the top of /structure. Deliberately
-- shaped like watched_system (same key, same position column, same policy):
-- a favorite is a UI preference belonging to the account, not a fact about a
-- character, so it keys on user_id rather than registration_id.
--
-- No FK to universe_structure: a user may pin a structure id before the
-- directory has learned a name for it, and losing the pin when a sweep drops
-- the directory row would be worse than showing the raw id.
create table if not exists public.structure_favorite (
  user_id      uuid   not null references auth.users (id) on delete cascade,
  structure_id bigint not null,
  created_at timestamptz not null default now(),
  -- Drag order (lower sorts first), mirroring watched_system.position.
  position   integer not null default 0,
  primary key (user_id, structure_id)
);
create index if not exists structure_favorite_user_id_idx on public.structure_favorite (user_id);

alter table public.structure_favorite enable row level security;

drop policy if exists "Users manage own structure favorites" on public.structure_favorite;
create policy "Users manage own structure favorites"
  on public.structure_favorite
  for all
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

grant select, insert, update, delete on public.structure_favorite to authenticated;
grant all                            on public.structure_favorite to service_role;

-- ── 3. corp_job_access ────────────────────────────────────────────────────
-- Observed capability, not a stated role. Every corp ESI endpoint needs an
-- in-game role on top of the OAuth scope (corp-structures wants Station
-- Manager, corp-assets wants Director, the wallet endpoints want Accountant),
-- and forEachCorporation already classifies the role-denial 403 to write
-- heartbeat.skipped_reason — it just discarded the fact afterwards. This table
-- keeps it.
--
-- Keyed on the job tag rather than a role name on purpose: we never learn which
-- role the character holds, only which endpoint it was able to pull. Recording
-- "can pull corp-structures for corp X" is exactly what we observed, and it is
-- what the fuel policy below needs. Reading roles properly would need
-- esi-characters.read_corporation_roles.v1 and a re-auth of every linked
-- character; if that is ever added it can fill this same table and no policy
-- has to change.
create table if not exists public.corp_job_access (
  registration_id uuid   not null references public.registration (id) on delete cascade,
  corporation_id  bigint not null,
  -- The extract tag that proved it, e.g. 'corp-structures'.
  job  text not null,
  observed_at timestamptz not null default now(),
  primary key (registration_id, corporation_id, job)
);
create index if not exists corp_job_access_corporation_id_idx on public.corp_job_access (corporation_id, job);

alter table public.corp_job_access enable row level security;

-- Users see their own characters' grants; that is all the /jobs page and the
-- fuel policy need. Written only by the extract jobs (service role).
drop policy if exists "Users read own corp job access" on public.corp_job_access;
create policy "Users read own corp job access"
  on public.corp_job_access
  for select
  to authenticated
  using (
    registration_id in (
      select id from public.registration where user_id = (select auth.uid())
    )
  );

grant select on public.corp_job_access to authenticated;
grant all    on public.corp_job_access to service_role;

-- ── 4a. Structure rigs open to the alliance ───────────────────────────────
-- A copy of corp_structure's "Alliance members read corp structures" policy.
-- A fitted rig is inferable from the structure's own bonuses in space, so it
-- was never really corp-private, and the /structure page shows rigs beside
-- structures the alliance can already see. Additive: OR'd with the existing
-- own-corps policy, which stays.
drop policy if exists "Alliance members read corp structure rigs" on public.corp_structure_rig;
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

-- ── 4b. Fuel narrows to directors ─────────────────────────────────────────
-- Fuel timers and the reinforcement profile are the one genuinely sensitive
-- thing here: a fuel expiry is a countdown to when the structure stops
-- shooting back. Restricting them to accounts that actually hold the role on
-- that corp, rather than to every corp member, is the point of the split that
-- created corp_structure_status in the first place.
--
-- Rank-and-file corp members lose the fuel column on /structure as a result.
-- The low-fuel Discord alerts are unaffected: that job runs service-role and
-- never sees RLS.
drop policy if exists "Users read structure status for own corps" on public.corp_structure_status;
drop policy if exists "Directors read structure status for own corps" on public.corp_structure_status;
create policy "Directors read structure status for own corps"
  on public.corp_structure_status
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.corp_job_access a
      join public.registration r on r.id = a.registration_id
      where a.corporation_id = corp_structure_status.corporation_id
        and a.job = 'corp-structures'
        and r.user_id = (select auth.uid())
    )
  );
