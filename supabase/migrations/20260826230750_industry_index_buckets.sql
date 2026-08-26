-- ── industry_system_index_bucket ──────────────────────────────────────────
-- Pre-bucketed cost-index history for the /structure and /structure/[id]
-- sparklines. The page used to read every raw industry_system_index row in
-- the window and average them in JS; at hourly collection that is 150 rows an
-- hour, so a 90-day window meant ~324k rows over ~324 sequential PostgREST
-- pages and the render blew its function budget ("destination stream closed
-- early"). The sparkline never draws more than ~180 points, so the averaging
-- belongs here, next to the data.
--
-- One row per (granularity, system, activity, bucket). Three granularities are
-- kept, each only as far back as the widest window that uses it: 1h backs the
-- 1/3/7-day windows, 6h the 14/30-day ones, 24h the 90-day one (see
-- src/app/structure/windows.ts, which picks the granularity by the same rule).
-- That caps the whole view at ~60k rows no matter how long the source table
-- accumulates, so a page load is a bounded handful of pages forever.
--
-- Buckets are epoch-aligned rather than date_trunc'd so they land exactly
-- where the client's Math.floor(epochMs / bucketMs) puts them, and stay
-- independent of the server's TimeZone setting. cost_index is the mean of the
-- readings in the bucket; recorded_at is the newest reading in it, which is
-- what the sparkline tooltip reports as "last updated".
create materialized view public.industry_system_index_bucket as
select
  g.bucket_hours::smallint as bucket_hours,
  i.system_id,
  i.activity,
  to_timestamp(floor(extract(epoch from i.recorded_at) / (g.bucket_hours * 3600)) * (g.bucket_hours * 3600)) as bucket_at,
  avg(i.cost_index)::real as cost_index,
  max(i.recorded_at) as recorded_at
from public.industry_system_index i
cross join (values (1, 8), (6, 31), (24, 91)) as g (bucket_hours, retention_days)
where i.recorded_at >= now() - make_interval(days => g.retention_days)
group by 1, 2, 3, 4;

-- Unique index required by REFRESH MATERIALIZED VIEW CONCURRENTLY; also the
-- access path for the page's query (granularity, then the system ids it asks
-- for, then the window's lower bound).
create unique index industry_system_index_bucket_uq
  on public.industry_system_index_bucket (bucket_hours, system_id, activity, bucket_at);

-- Materialized views can't carry RLS; a SELECT-only grant gives the same
-- world-readable, nobody-writes access as industry_system_index itself, whose
-- contents this only summarizes.
grant select on public.industry_system_index_bucket to anon, authenticated, service_role;

-- Refreshed at the end of every industry-systems run, right after the run's
-- rows land. Concurrent so the page keeps reading the previous contents while
-- the refresh runs.
create or replace function public.refresh_industry_index_buckets()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  refresh materialized view concurrently public.industry_system_index_bucket;
end
$$;

revoke execute on function public.refresh_industry_index_buckets() from public, anon, authenticated;
grant execute on function public.refresh_industry_index_buckets() to service_role;
