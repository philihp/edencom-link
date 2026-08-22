-- Split structure_tax_revenue's one signed total into received vs self-paid.
--
-- industry_job_tax entries cut both ways in a corp wallet, and summing them
-- together reported the wrong thing under a heading that says "Tax Revenue".
-- A job installed AS THE CORPORATION bills the corp wallet rather than the
-- installer's; when that corporation also owns the structure, the ISK never
-- leaves the entity and CCP writes only the outgoing side. A corp that runs
-- everything under corp ownership therefore has nothing BUT negative entries,
-- and /structure/[structureId] reported its busiest structures as earning
-- large negative revenue.
--
-- The two measures are kept apart rather than netted because they answer
-- different questions: `isk` is money that arrived, `isk_self_paid` is the
-- own-rate charge behind the cost-avoidance figure on /structure (see
-- docs/cost-avoidance.md and src/app/structure/taxLedger.ts). `jobs` likewise
-- splits, so neither count is inflated by the other's rows.
--
-- Return type changes, so this drops and recreates rather than replacing.
-- Everything else about the function — the security INVOKER rationale, the
-- delegation of the RLS-crossing step to industry_job_tax_facility() — is
-- unchanged; see schema.sql for that commentary.
drop function if exists public.structure_tax_revenue(bigint, timestamptz);

create function public.structure_tax_revenue(structure_id bigint, since timestamptz)
returns table (payer_id bigint, day date, jobs bigint, isk numeric, self_paid_jobs bigint, isk_self_paid numeric)
language sql
stable
as $$
  with tax as (
    select w.first_party_id, w.date, w.amount, w.context_id
    from public.corp_wallet_journal w
    where w.ref_type = 'industry_job_tax'
      and w.context_id is not null
      and w.date >= since
  ),
  -- One call for the whole window rather than per row; the function dedupes to
  -- at most one location per job.
  located as (
    select f.job_id, f.station_id, f.facility_id
    from public.industry_job_tax_facility(array(select distinct t.context_id from tax t)) f
  )
  select
    t.first_party_id                                            as payer_id,
    (t.date at time zone 'UTC')::date                           as day,
    count(*) filter (where t.amount > 0)                        as jobs,
    coalesce(sum(t.amount) filter (where t.amount > 0), 0)      as isk,
    count(*) filter (where t.amount < 0)                        as self_paid_jobs,
    coalesce(-sum(t.amount) filter (where t.amount < 0), 0)     as isk_self_paid
  from tax t
  join located l on l.job_id = t.context_id
  -- Upwell structures share the id between station_id and facility_id; jobs in
  -- NPC stations carry only station_id. Same coalesce the revenue page uses.
  where coalesce(l.station_id, l.facility_id) = structure_tax_revenue.structure_id
  -- Positional, so the output column names can't shadow anything in `tax`.
  group by 1, 2
  order by 2 desc, 4 desc;
$$;

grant execute on function public.structure_tax_revenue(bigint, timestamptz) to authenticated, service_role;
