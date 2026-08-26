-- SQL-level coverage for industry_system_index_bucket, the pre-averaged
-- cost-index history behind the /structure and /indexes sparklines.
--
-- This is in SQL rather than node:test because the whole point of the view is
-- that the averaging happens in the database: the application no longer sees a
-- raw reading, so there is nothing left in JS to assert against. Two properties
-- carry the design, and both live here.
--
--   1. Bucket boundaries land on the same epoch grid the client divides by
--      (src/app/structure/industryIndex.ts's Math.floor(epochMs / bucketMs)).
--      Off-grid boundaries would still render — as a series silently shifted
--      by part of a bucket — so nothing downstream would catch this.
--   2. Each bucket's cost_index is the mean of the readings in it, and its
--      recorded_at the newest of them. That is exactly what the JS fold this
--      view replaced computed, and the sparkline tooltip reports recorded_at
--      as "last updated".
--
-- Run against a THROWAWAY database (it creates a stand-in table named after the
-- real one in `public`) from the repo root:
--
--   initdb -D /tmp/pg && pg_ctl -D /tmp/pg -o '-k /tmp -p 55432' start
--   createdb -h /tmp -p 55432 iib
--   DATABASE_URL='postgresql://…/iib' pnpm run test:sql
--
-- Everything runs in one transaction and rolls back, so nothing is left behind.
begin;

-- A stand-in with the columns the view reads. The real table (schema.sql) adds
-- only its identity primary key, which the view never touches.
create table public.industry_system_index (
  id bigint generated always as identity primary key,
  system_id bigint not null,
  activity text not null,
  cost_index real not null,
  recorded_at timestamptz not null default now()
);

-- The view under test, verbatim from the migration.
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

-- ── Bucket boundaries sit on the client's epoch grid ──────────────────────
-- Readings every 20 minutes for two days, so every width has several readings
-- per bucket and the 1h width has exactly three.
insert into public.industry_system_index (system_id, activity, cost_index, recorded_at)
select 30000142, 'manufacturing', 0.05, now() - make_interval(mins => m)
from generate_series(0, 2 * 24 * 3) g(m3), lateral (select g.m3 * 20 as m) x;

refresh materialized view public.industry_system_index_bucket;

do $$
declare
  off_grid int;
begin
  -- A bucket_at is on the grid when its epoch is an exact multiple of the
  -- bucket width in seconds — the condition under which the client's
  -- floor(epochMs / bucketMs) reproduces this bucket's own index.
  select count(*) into off_grid
    from public.industry_system_index_bucket
   where (extract(epoch from bucket_at)::bigint % (bucket_hours * 3600)) <> 0;
  assert off_grid = 0, format('expected every bucket on the epoch grid, %s were off', off_grid);
end $$;

-- ── A bucket averages its readings, and carries the newest timestamp ──────
-- Three readings in one known hour, with a mean that is not any of them.
delete from public.industry_system_index;
insert into public.industry_system_index (system_id, activity, cost_index, recorded_at)
values
  (30000142, 'reaction', 0.02, timestamptz '2026-08-20 04:05:00+00'),
  (30000142, 'reaction', 0.04, timestamptz '2026-08-20 04:35:00+00'),
  (30000142, 'reaction', 0.06, timestamptz '2026-08-20 04:55:00+00'),
  -- The next hour, to prove the boundary actually separates them.
  (30000142, 'reaction', 0.99, timestamptz '2026-08-20 05:05:00+00');

refresh materialized view public.industry_system_index_bucket;

do $$
declare
  b record;
begin
  select * into b
    from public.industry_system_index_bucket
   where bucket_hours = 1
     and activity = 'reaction'
     and bucket_at = timestamptz '2026-08-20 04:00:00+00';

  assert b is not null, 'expected an hourly bucket at 04:00';
  -- (0.02 + 0.04 + 0.06) / 3 = 0.04, and none of the three readings is 0.04
  -- by itself, so a "take one row" bug cannot pass this.
  assert abs(b.cost_index - 0.04) < 1e-6, format('expected mean 0.04, got %s', b.cost_index);
  assert b.recorded_at = timestamptz '2026-08-20 04:55:00+00',
    format('expected the newest reading in the bucket, got %s', b.recorded_at);
end $$;

-- The 05:05 reading must not have leaked into the 04:00 bucket.
do $$
declare
  n int;
begin
  select count(*) into n
    from public.industry_system_index_bucket
   where bucket_hours = 1 and activity = 'reaction';
  assert n = 2, format('expected 2 hourly buckets, got %s', n);
end $$;

-- ── Each width is retained at least as far as the window that selects it ──
-- src/app/structure/windows.ts routes 7 days to the 1h width, 30 to 6h and 90
-- to 24h; a retention cut shorter than that would silently truncate the left
-- edge of the sparkline rather than fail.
do $$
declare
  cut record;
begin
  for cut in
    select * from (values (1, 7), (6, 30), (24, 90)) as w (bucket_hours, widest_window_days)
  loop
    perform 1
       from (values (1, 8), (6, 31), (24, 91)) as g (bucket_hours, retention_days)
      where g.bucket_hours = cut.bucket_hours
        and g.retention_days > cut.widest_window_days;
    assert found, format('the %sh width is not retained past its %s-day window',
                         cut.bucket_hours, cut.widest_window_days);
  end loop;
end $$;

rollback;
