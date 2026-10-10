-- Co-tenants read each other's industry jobs (docs/sharing-layer/13-industry-job-share.md,
-- as decided 2026-10-08: no opt-in). Everyone with an open job at a player
-- structure reads the current job rows of everyone else building there — the
-- same structure is the grant. People sharing a structure are allies by
-- construction, the job count in a system is public in the client anyway, and
-- whoever is building something opsec-sensitive there is only visible to
-- others the owner has already let build there.
--
-- What crosses: current rows (never SCD-2 history) and everything on them but
-- `cost`, which the two views below blank unless the row is the caller's own —
-- at a structure whose facility tax the caller knows, `cost` inverts to the
-- job's EIV exactly, and at any structure to the owner's tax rate
-- (src/app/structure/eiv.ts does that inversion on purpose for one's OWN
-- jobs). The `_over_time` tables themselves stay readable by `authenticated`
-- (character_industry_jobs() and the time-travel RPCs read them on invoker
-- rights), so a direct PostgREST read of the table still carries `cost`; the
-- app reads jobs through the views everywhere a user client is involved.
--
-- Tenancy is read from structure_tenant through a set-returning helper rather
-- than is_tenant_of() per row: the /structure page drains every current job
-- the caller may see, and an uncorrelated subquery hashes once where a
-- per-row EXISTS would probe structure_tenant for each of thousands of rows.
-- Neither policy reads a job table, so neither recurses.

-- Every player structure at which the caller holds an open job, personally or
-- through a corporation of theirs. Invoker rights, over rows the caller's own
-- structure_tenant policy already shows.
create or replace function public.my_tenant_structure_ids()
returns setof bigint
language sql
stable
set search_path = public
as $$
  select t.structure_id
  from public.structure_tenant t
  where t.open_jobs > 0
    and (
      t.registration_id in (
        select id from public.registration where user_id = (select auth.uid())
      )
      or t.corporation_id in (select public.my_corporation_ids())
    );
$$;

grant execute on function public.my_tenant_structure_ids() to authenticated, service_role;

-- Upwell structures carry the same id in station_id and facility_id; NPC
-- stations carry only station_id, and never appear in structure_tenant, so a
-- job in Jita 4-4 is widened to nobody.
create policy "Tenants read industry jobs at shared structures"
  on public.character_industry_job_over_time
  for select
  to authenticated
  using (
    is_current
    and coalesce(station_id, facility_id) in (select public.my_tenant_structure_ids())
  );

create policy "Tenants read corp industry jobs at shared structures"
  on public.corp_industry_job_over_time
  for select
  to authenticated
  using (
    is_current
    and coalesce(station_id, facility_id) in (select public.my_tenant_structure_ids())
  );

-- The views, with `cost` masked on rows that are not the caller's own.
-- Dropped and recreated rather than replaced: the production views were made
-- by `select *` over tables that gained `id` through `alter table add column`
-- (migration 20260713140000), so there `id` is the LAST column, while a
-- database built from schema.sql has it first. `create or replace view` must
-- keep every column's name and position, so spelling schema.sql's order
-- against the production view failed with "cannot change name of view column
-- job_id to id" (2026-10-08) and held every later migration back until this
-- was rewritten. Nothing depends on the views (the functions below name them
-- inside SQL bodies, which Postgres does not track), so the drop is free and
-- the recreate puts every environment on schema.sql's column order.
drop view if exists public.character_industry_job;
create view public.character_industry_job with (security_invoker = on) as
  select
    id, job_id, registration_id, installer_id, facility_id, station_id, activity_id,
    blueprint_id, blueprint_type_id, blueprint_location_id, output_location_id,
    product_type_id, runs,
    (case
      when registration_id in (select r.id from public.registration r where r.user_id = (select auth.uid()))
      then cost
    end)::numeric(20, 2) as cost,
    licensed_runs, probability, status, duration, start_date, end_date, pause_date,
    completed_date, completed_character_id, successful_runs, is_current, valid_from, valid_until
  from public.character_industry_job_over_time
  where is_current;
grant select on public.character_industry_job to anon, authenticated, service_role;

drop view if exists public.corp_industry_job;
create view public.corp_industry_job with (security_invoker = on) as
  select
    id, job_id, corporation_id, installer_id, facility_id, station_id, activity_id,
    blueprint_id, blueprint_type_id, blueprint_location_id, output_location_id,
    product_type_id, runs,
    (case
      when corporation_id in (select public.my_corporation_ids())
      then cost
    end)::numeric(20, 2) as cost,
    licensed_runs, probability, status, duration, start_date, end_date, pause_date,
    completed_date, completed_character_id, successful_runs, is_current, valid_from, valid_until
  from public.corp_industry_job_over_time
  where is_current;
grant select on public.corp_industry_job to anon, authenticated, service_role;

-- structure_tax_revenue() decided "is this job ours" by whether the views
-- showed it at all, which the policies above make false: a tenant's job at
-- our structure is now visible too, and read as ours it would have been filed
-- as an own-rate charge instead of revenue. Scope `ours` and `personal` to the
-- caller's registrations and corporations explicitly. Everything else in the
-- function is as it was (see schema.sql for the full commentary).
create or replace function public.structure_tax_revenue(structure_id bigint, since timestamptz)
returns table (
  payer_id bigint,
  day date,
  jobs bigint,
  isk numeric,
  self_paid_jobs bigint,
  isk_self_paid numeric,
  paid_jobs bigint,
  isk_paid numeric,
  total_jobs bigint,
  isk_total numeric
)
language sql
stable
as $$
  with tax as (
    select w.first_party_id, w.corporation_id, w.date, w.amount, w.context_id
    from public.corp_wallet_journal w
    where w.ref_type = 'industry_job_tax'
      and w.context_id is not null
      and w.date >= since
  ),
  taxed_jobs as (
    select distinct t.context_id as job_id from tax t
  ),
  owned as (
    select exists (
      select 1
      from public.corp_structure cs
      where cs.structure_id = structure_tax_revenue.structure_id
        and cs.corporation_id in (select public.my_corporation_ids())
    ) as ours
  ),
  located as (
    select f.job_id, f.station_id, f.facility_id
    from public.industry_job_tax_facility(array(select j.job_id from taxed_jobs j)) f
  ),
  -- Jobs of ours, either way they were installed. The views also show a
  -- co-tenant's job at a structure we build in, so ownership is tested on the
  -- row rather than assumed from its visibility.
  ours as (
    select cij.job_id from public.character_industry_job cij
    where cij.job_id in (select job_id from taxed_jobs)
      and cij.registration_id in (select r.id from public.registration r where r.user_id = (select auth.uid()))
    union
    select coj.job_id from public.corp_industry_job coj
    where coj.job_id in (select job_id from taxed_jobs)
      and coj.corporation_id in (select public.my_corporation_ids())
  ),
  personal as (
    select cij.job_id from public.character_industry_job cij
    where cij.job_id in (select job_id from taxed_jobs)
      and cij.registration_id in (select r.id from public.registration r where r.user_id = (select auth.uid()))
  ),
  scoped as (
    select
      t.first_party_id,
      t.date,
      t.amount,
      p.job_id is not null as is_personal,
      case
        when t.amount < 0 then (select ours from owned)
        else o.job_id is not null and (select ours from owned)
      end as own_rate
    from tax t
    join located l on l.job_id = t.context_id
    left join ours o on o.job_id = t.context_id
    left join personal p on p.job_id = t.context_id
    where coalesce(l.station_id, l.facility_id) = structure_tax_revenue.structure_id
  )
  select
    s.first_party_id                                                as payer_id,
    (s.date at time zone 'UTC')::date                               as day,
    count(*) filter (where s.amount > 0)                            as jobs,
    coalesce(sum(s.amount) filter (where s.amount > 0), 0)          as isk,
    count(*) filter (where s.own_rate)                              as self_paid_jobs,
    coalesce(sum(abs(s.amount)) filter (where s.own_rate), 0)       as isk_self_paid,
    count(*) filter (where s.amount < 0 or s.is_personal)           as paid_jobs,
    coalesce(sum(abs(s.amount)) filter (where s.amount < 0 or s.is_personal), 0) as isk_paid,
    count(*)                                                        as total_jobs,
    coalesce(sum(abs(s.amount)), 0)                                 as isk_total
  from scoped s
  group by 1, 2
  order by 2 desc, 4 desc;
$$;
