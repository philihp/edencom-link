-- Attribute industry tax revenue to the structure that earned it.
--
-- /structure/revenue lists corp_wallet_journal entries with ref_type
-- 'industry_job_tax' and resolves each one's structure by looking the job up in
-- character_industry_job / corp_industry_job. Both are RLS-scoped to the
-- caller, so a job installed by another player who uses this site — their rows
-- live under their own registration — resolves to nothing and the entry lands
-- in the "unknown structure" bucket, even though the tax landed in the
-- caller's wallet.
--
-- This function discloses exactly one fact about such a job, and nothing else:
-- the structure owner who was paid tax for a job learns which of their
-- structures it ran in. No installer, product, runs, cost, blueprint, or
-- status crosses the boundary — only job_id -> station_id/facility_id, and
-- only for a job the caller can already prove they were taxed for.
--
-- security definer bypasses RLS on every table read here, so the caller's
-- scope is restated explicitly in the exists() clause below rather than
-- inherited from corp_wallet_journal's policy. That clause is the whole
-- disclosure rule; there is no other path to a row.
--
-- Matching is on context_id only (context_id_type = 'industry_job_id'). The
-- page also scrapes numeric tokens out of older entries' description text as a
-- fallback, but those tokens must not reach this function: a token that
-- happened to collide with a real job id would turn it into an oracle for
-- jobs the caller was never taxed for.
create or replace function public.industry_job_tax_facility(job_ids bigint[])
returns table (job_id bigint, station_id bigint, facility_id bigint)
language sql
stable
security definer
set search_path = public
as $$
  -- distinct on keeps one row per job; the two sources are disjoint in
  -- practice (personal vs corp-installed jobs), but the page keys by job_id
  -- and a duplicate would be silently ambiguous.
  select distinct on (j.job_id) j.job_id, j.station_id, j.facility_id
  from (
    select job_id, station_id, facility_id
      from public.character_industry_job_over_time
      where is_current
    union all
    select job_id, station_id, facility_id
      from public.corp_industry_job_over_time
      where is_current
  ) j
  where j.job_id = any(job_ids)
    and exists (
      select 1
      from public.corp_wallet_journal w
      where w.context_id = j.job_id
        and w.ref_type = 'industry_job_tax'
        and w.corporation_id in (
          select corporation_id from public.registration
          where user_id = (select auth.uid()) and corporation_id is not null
        )
    )
  order by j.job_id;
$$;

-- anon would get nothing anyway (auth.uid() is null collapses the corp
-- subselect to empty), but the grant says so rather than relying on it.
revoke execute on function public.industry_job_tax_facility(bigint[]) from public, anon;
grant  execute on function public.industry_job_tax_facility(bigint[]) to authenticated, service_role;
