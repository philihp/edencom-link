-- Tenancy expires 30 days after the last job (docs/sharing-layer/13-industry-job-share.md).
--
-- is_tenant_of() and my_tenant_structure_ids() asked for an OPEN job, which
-- cut both ways wrong: a tenant lost the co-tenant view the moment their last
-- job delivered, and a row whose extract stopped reporting (token revoked,
-- character unlinked) stayed "open" forever. structure_tenant.last_job_seen_at
-- is stamped with the run clock on every extract run that saw an open job
-- there, so it reads as "the last time this owner had something running or
-- undelivered at this structure". Tenancy is now that stamp within the last
-- 30 days, and nothing else: someone who has not run a job at a structure in
-- 30 days sees nothing there any more, and a stale row ages out on its own.

create or replace function public.is_tenant_of(structure bigint)
returns boolean
language sql
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.structure_tenant t
    where t.structure_id = structure
      and t.last_job_seen_at >= now() - interval '30 days'
      and (
        t.registration_id in (
          select id from public.registration where user_id = (select auth.uid())
        )
        or t.corporation_id in (select public.my_corporation_ids())
      )
  );
$$;

create or replace function public.my_tenant_structure_ids()
returns setof bigint
language sql
stable
set search_path = public
as $$
  select t.structure_id
  from public.structure_tenant t
  where t.last_job_seen_at >= now() - interval '30 days'
    and (
      t.registration_id in (
        select id from public.registration where user_id = (select auth.uid())
      )
      or t.corporation_id in (select public.my_corporation_ids())
    );
$$;

-- The structure-side index served "open tenants here"; the predicate is now
-- the stamp, which a partial index on a moving now() cannot express.
drop index if exists public.structure_tenant_structure_id_idx;
create index structure_tenant_structure_id_idx on public.structure_tenant (structure_id, last_job_seen_at desc);
