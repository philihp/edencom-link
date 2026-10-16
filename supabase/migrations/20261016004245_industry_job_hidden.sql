-- Hidden industry jobs (docs/sharing-layer/16-industry-job-share.md, PR 1).
--
-- The co-tenant default stays (phase 13: everyone with a job at a player
-- structure in the last 30 days reads every other tenant's current jobs
-- there), but an owner can now quietly take one job back: a row here names
-- the job, and the widened read paths stop showing it. The owner always still
-- sees it. Nothing tells a co-tenant the job was hidden rather than gone.
--
-- Keyed on the job's identity, not a version row, so the extract's SCD-2
-- versioning never touches it: a job that goes active → ready opens a new
-- version and is still named here. ESI job ids are global, and a corp job
-- installed by one of our own characters appears in BOTH job tables under the
-- same job_id — one row here hides both.

create table public.industry_job_hidden (
  job_id bigint primary key,
  -- Exactly one owner key: the registration whose personal job it is, or the
  -- corporation the job was run for (structure_tenant's shape).
  registration_id uuid references public.registration (id) on delete cascade,
  corporation_id  bigint,
  -- For a corp job: the member who hid it, one of the caller's own characters
  -- in that corporation (the insert policy's with check). Audit only, never
  -- shown. A hide persists when they leave — hidden is a restriction, not a
  -- grant, so the safe direction is to keep it.
  hidden_by uuid references public.registration (id) on delete set null,
  hidden_at timestamptz not null default now(),
  owner_key text generated always as (coalesce(registration_id::text, 'corp:' || corporation_id::text)) stored,
  check ((registration_id is null) <> (corporation_id is null))
);
create index industry_job_hidden_owner_key_idx on public.industry_job_hidden (owner_key);

alter table public.industry_job_hidden enable row level security;

-- Owner-managed: own rows only, a character's through its registration, a
-- corporation's through membership (any member — phase 14's rule).
create policy "Users read own hidden jobs"
  on public.industry_job_hidden
  for select
  to authenticated
  using (
    registration_id in (select id from public.registration where user_id = (select auth.uid()))
    or corporation_id in (select public.my_corporation_ids())
  );

-- The insert proves the caller owns the job it names: the job table's owner
-- policy answers that, since a co-tenant's row matches neither owner test
-- below even when the tenant policy lets the caller read it. The read goes
-- through the job tables' SELECT policies, one of which calls
-- hidden_industry_job_ids() — which reads this table directly as its definer,
-- never through these policies, so there is no cycle.
create policy "Users hide own industry jobs"
  on public.industry_job_hidden
  for insert
  to authenticated
  with check (
    (
      registration_id in (select id from public.registration where user_id = (select auth.uid()))
      and hidden_by is null
      and exists (
        select 1 from public.character_industry_job_over_time j
        where j.job_id = industry_job_hidden.job_id
          and j.registration_id = industry_job_hidden.registration_id
      )
    )
    or (
      corporation_id in (select public.my_corporation_ids())
      and hidden_by in (
        select r.id from public.registration r
        where r.user_id = (select auth.uid()) and r.corporation_id = industry_job_hidden.corporation_id
      )
      and exists (
        select 1 from public.corp_industry_job_over_time j
        where j.job_id = industry_job_hidden.job_id
          and j.corporation_id = industry_job_hidden.corporation_id
      )
    )
  );

-- Unhide is a delete; there is no update (hide is an insert). A corp job may
-- be unhidden by any member, as it may be hidden by any member.
create policy "Users unhide own industry jobs"
  on public.industry_job_hidden
  for delete
  to authenticated
  using (
    registration_id in (select id from public.registration where user_id = (select auth.uid()))
    or corporation_id in (select public.my_corporation_ids())
  );

grant select, insert, delete on public.industry_job_hidden to authenticated;
grant all                    on public.industry_job_hidden to service_role;

-- Every hidden job id, for the widening policies. A co-tenant's RLS cannot
-- read the owner's rows above, and a world-readable table of hidden ids would
-- tell them exactly what "quietly" forbids, so the set is read through a
-- definer — the my_tenant_structure_ids() / corp_shared_item_ids() shape:
-- argument-free and stable, so the planner evaluates it once per statement
-- into a hashed subplan; it reads only this table, so no recursion. It returns
-- bare job ids, nothing else. What that discloses: a direct caller reads every
-- hidden job id in the system — a number with no meaning to anyone who never
-- saw the job; someone who had seen it before it was hidden could confirm its
-- id is in the set. The doc accepts that residue.
create or replace function public.hidden_industry_job_ids()
returns setof bigint
language sql
stable
security definer
set search_path = public
as $$
  select job_id from public.industry_job_hidden;
$$;
revoke execute on function public.hidden_industry_job_ids() from public;
grant execute on function public.hidden_industry_job_ids() to anon, authenticated, service_role;

-- The two tenant policies (migrations 20261008005932, 20261008050729) gain
-- one conjunct. Policies are not views, so nothing here needs the view
-- recreate that migration describes. The owner policies do not test it: the
-- owner always sees their own job, hidden or not.
drop policy if exists "Tenants read industry jobs at shared structures" on public.character_industry_job_over_time;
create policy "Tenants read industry jobs at shared structures"
  on public.character_industry_job_over_time
  for select
  to authenticated
  using (
    is_current
    and coalesce(station_id, facility_id) in (select public.my_tenant_structure_ids())
    and job_id not in (select public.hidden_industry_job_ids())
  );

drop policy if exists "Tenants read corp industry jobs at shared structures" on public.corp_industry_job_over_time;
create policy "Tenants read corp industry jobs at shared structures"
  on public.corp_industry_job_over_time
  for select
  to authenticated
  using (
    is_current
    and coalesce(station_id, facility_id) in (select public.my_tenant_structure_ids())
    and job_id not in (select public.hidden_industry_job_ids())
  );
