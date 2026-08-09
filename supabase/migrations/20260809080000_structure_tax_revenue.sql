-- Per-structure industry tax revenue, broken down by payer and UTC day, for the
-- Tax Revenue table on /structure/[structureId].
--
-- This can't be a plain PostgREST query: corp_wallet_journal knows only the job
-- (context_id), never the structure, so "tax earned by THIS structure" needs the
-- job -> facility hop before it can filter. Doing that in the page would mean
-- pulling every tax entry in the window past PostgREST's 1000-row cap and
-- discarding most of them client-side; here the join, the filter and the
-- aggregation all happen in one round trip.
--
-- security INVOKER, deliberately: corp_wallet_journal's own policy scopes the
-- caller to their corps' entries, which is exactly the right scope. The one step
-- that needs to see past RLS — resolving another player's job to its structure —
-- is delegated to industry_job_tax_facility(), which is security definer and
-- carries the whole disclosure rule (the structure owner who was paid tax for a
-- job learns which of their structures it ran in). auth.uid() survives the call,
-- so that function scopes to the same caller. Keeping the rule in one place
-- means this function cannot widen it.
--
-- Payer identity crosses no new boundary: first_party_id is already on the
-- journal row the caller can read, and /structure/revenue already displays it.
create or replace function public.structure_tax_revenue(structure_id bigint, since timestamptz)
returns table (payer_id bigint, day date, jobs bigint, isk numeric)
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
    t.first_party_id                  as payer_id,
    (t.date at time zone 'UTC')::date as day,
    count(*)                          as jobs,
    sum(coalesce(t.amount, 0))        as isk
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
