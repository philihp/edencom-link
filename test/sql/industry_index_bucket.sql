-- SQL-level coverage for industry_system_index_bucket, the pre-averaged
-- cost-index history behind the /structure and /indexes sparklines, and for
-- refresh_industry_index_buckets(), which the industry-systems job calls after
-- each run to keep it current
-- (supabase/migrations/20261116231117_industry_index_bucket_incremental.sql).
--
-- This is in SQL rather than node:test because the averaging happens in the
-- database: the application never sees a raw reading. What carries the design:
--
--   1. Bucket boundaries land on the same epoch grid the client divides by
--      (src/app/structure/industryIndex.ts's Math.floor(epochMs / bucketMs)).
--      Off-grid boundaries would still render — as a series silently shifted
--      by part of a bucket — so nothing downstream would catch this.
--   2. Each bucket's cost_index is the mean of the readings in it, and its
--      recorded_at the newest of them (the sparkline tooltip's "last updated").
--   3. The refresh is incremental — it recomputes only the buckets from the
--      newest hourly bucket on, less a three-hour margin — yet the table always
--      equals a from-scratch computation over the source: a first call fills
--      it, a later one folds new readings into the current buckets, a late
--      reading inside the margin is picked up, and an aged-out bucket goes.
--   4. A refresh writes nothing for a bucket that did not change. That is the
--      point of the rewrite: the materialized view it replaced rebuilt and
--      diffed everything every hour.
--   5. Each width reaches back at least as far as the widest window that
--      selects it (src/app/structure/windows.ts).
--
-- Run against a THROWAWAY database (it creates a stand-in table named after the
-- real one in `public`) from the repo root, so the \i below resolves:
--
--   DATABASE_URL='postgresql://…/throwaway' pnpm run test:sql
--
-- Everything runs in one transaction and rolls back, so nothing is left behind.
begin;

do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin; exception when duplicate_object then null; end $$;

-- A stand-in with the real table's columns (schema.sql).
create table public.industry_system_index (
  id bigint generated always as identity primary key,
  system_id bigint not null,
  activity text not null,
  cost_index real not null,
  recorded_at timestamptz not null default now()
);
create index industry_system_index_recorded_at_idx on public.industry_system_index (recorded_at desc);

\i supabase/migrations/20261116231117_industry_index_bucket_incremental.sql

-- What the table must hold after any refresh: every retained bucket, computed
-- from scratch over the whole source. Each width keeps the buckets from the one
-- holding the moment 8, 31 or 91 days ago — and those buckets' readings are
-- exactly the readings on or after that bucket's start.
create temp view bucket_reference as
select
  g.bucket_hours::smallint as bucket_hours,
  i.system_id,
  i.activity,
  to_timestamp(floor(extract(epoch from i.recorded_at) / (g.bucket_hours * 3600)) * (g.bucket_hours * 3600)) as bucket_at,
  avg(i.cost_index)::real as cost_index,
  max(i.recorded_at) as recorded_at
from public.industry_system_index i
cross join (values (1, 8), (6, 31), (24, 91)) as g (bucket_hours, retention_days)
where i.recorded_at >= to_timestamp(
  floor(extract(epoch from now() - make_interval(days => g.retention_days)) / (g.bucket_hours * 3600))
  * (g.bucket_hours * 3600)
)
group by 1, 2, 3, 4;

-- Every bucket missing from either side, or holding a different value.
create temp view bucket_mismatch as
select
  coalesce(r.bucket_hours, b.bucket_hours) as bucket_hours,
  coalesce(r.activity, b.activity) as activity,
  coalesce(r.bucket_at, b.bucket_at) as bucket_at,
  r.cost_index as expected_cost_index,
  b.cost_index as actual_cost_index
from bucket_reference r
full join public.industry_system_index_bucket b
  on b.bucket_hours = r.bucket_hours
 and b.system_id = r.system_id
 and b.activity = r.activity
 and b.bucket_at = r.bucket_at
where r.bucket_hours is null
   or b.bucket_hours is null
   or abs(r.cost_index - b.cost_index) > 1e-6
   or r.recorded_at <> b.recorded_at;

create function pg_temp.assert_matches_reference(context text) returns void language plpgsql as $$
declare
  n int;
  example record;
begin
  select count(*) into n from bucket_mismatch;
  select * into example from bucket_mismatch limit 1;
  assert n = 0, format('%s: %s bucket(s) differ from a full recompute, e.g. %s', context, n, example);
end
$$;

-- The start of the UTC day two days ago: a fixed point on every width's grid,
-- old enough to sit behind the watermark once newer readings land.
create temp table anchor as
select to_timestamp(floor(extract(epoch from now() - interval '2 days') / 86400) * 86400) as anchor_at;

-- ── A first refresh fills every retained bucket ───────────────────────────
-- Readings every 20 minutes for ten days ending now, for two series, so every
-- width has several readings per bucket and the 1h width runs past its 8-day
-- retention.
insert into public.industry_system_index (system_id, activity, cost_index, recorded_at)
select s.system_id, 'manufacturing', 0.01 + (m % 7) * 0.003, now() - make_interval(mins => m * 20)
from generate_series(0, 10 * 24 * 3) m
cross join (values (30000142), (30002187)) s (system_id);

-- One reading a day for 100 days, so the 6h and 24h widths run past 31 and
-- 91 days.
insert into public.industry_system_index (system_id, activity, cost_index, recorded_at)
select 30000144, 'invention', 0.02 + (d % 5) * 0.01, now() - make_interval(days => d, mins => 17)
from generate_series(0, 100) d;

-- Three readings in one known hour, with a mean that is none of them, and one
-- in the next hour to prove the boundary separates them.
insert into public.industry_system_index (system_id, activity, cost_index, recorded_at)
select 30000142, 'reaction', v.cost_index, (select anchor_at from anchor) + v.after
from (values
  (0.02::real, interval '5 minutes'),
  (0.04, interval '35 minutes'),
  (0.06, interval '55 minutes'),
  (0.99, interval '65 minutes')
) v (cost_index, after);

select public.refresh_industry_index_buckets();

select pg_temp.assert_matches_reference('first refresh');

do $$
declare
  off_grid int;
  b record;
  n int;
begin
  -- A bucket_at is on the grid when its epoch is an exact multiple of the
  -- bucket width in seconds — the condition under which the client's
  -- floor(epochMs / bucketMs) reproduces this bucket's own index.
  select count(*) into off_grid
    from public.industry_system_index_bucket
   where (extract(epoch from bucket_at)::bigint % (bucket_hours * 3600)) <> 0;
  assert off_grid = 0, format('expected every bucket on the epoch grid, %s were off', off_grid);

  select * into b
    from public.industry_system_index_bucket
   where bucket_hours = 1
     and activity = 'reaction'
     and bucket_at = (select anchor_at from anchor);
  assert b is not null, 'expected an hourly reaction bucket at the anchor';
  -- (0.02 + 0.04 + 0.06) / 3 = 0.04, and none of the three readings is 0.04
  -- by itself, so a "take one row" bug cannot pass this.
  assert abs(b.cost_index - 0.04) < 1e-6, format('expected mean 0.04, got %s', b.cost_index);
  assert b.recorded_at = (select anchor_at from anchor) + interval '55 minutes',
    format('expected the newest reading in the bucket, got %s', b.recorded_at);

  -- The 65-minute reading must not have leaked into the anchor's bucket.
  select count(*) into n
    from public.industry_system_index_bucket
   where bucket_hours = 1 and activity = 'reaction';
  assert n = 2, format('expected 2 hourly reaction buckets, got %s', n);
end $$;

-- ── Each width reaches back past the widest window that selects it ─────────
-- src/app/structure/windows.ts routes 7 days to the 1h width, 30 to 6h and 90
-- to 24h; a retention cut shorter than that would silently truncate the left
-- edge of the sparkline rather than fail.
do $$
declare
  cut record;
  oldest timestamptz;
begin
  for cut in select * from (values (1, 7), (6, 30), (24, 90)) as w (bucket_hours, widest_window_days)
  loop
    select min(bucket_at) into oldest
      from public.industry_system_index_bucket
     where bucket_hours = cut.bucket_hours;
    assert oldest <= now() - make_interval(days => cut.widest_window_days),
      format('the %sh width starts at %s, inside its %s-day window', cut.bucket_hours, oldest, cut.widest_window_days);
  end loop;
end $$;

-- ── A later refresh rewrites only what new readings touched ───────────────
create temp table before_new_readings as
select bucket_hours, system_id, activity, bucket_at, ctid as tid
from public.industry_system_index_bucket;

-- Two new readings for one series, in the current hour.
insert into public.industry_system_index (system_id, activity, cost_index, recorded_at)
values
  (30002187, 'manufacturing', 0.5, now() + interval '1 second'),
  (30002187, 'manufacturing', 0.7, now() + interval '2 seconds');

select public.refresh_industry_index_buckets();

select pg_temp.assert_matches_reference('after new readings');

do $$
declare
  rewritten int;
begin
  -- Every row of a series the new readings did not touch is the same tuple it
  -- was: no update, not even one that wrote back the same value. (ctid rather
  -- than xmin: the whole test is one transaction, so every write shares an xid.)
  select count(*) into rewritten
    from before_new_readings p
    join public.industry_system_index_bucket b
      on b.bucket_hours = p.bucket_hours and b.system_id = p.system_id
     and b.activity = p.activity and b.bucket_at = p.bucket_at
   where b.ctid <> p.tid
     and not (b.system_id = 30002187 and b.activity = 'manufacturing');
  assert rewritten = 0, format('expected untouched series left alone, %s bucket(s) rewritten', rewritten);

  -- And of the touched series, only its current 1h, 6h and 24h buckets.
  select count(*) into rewritten
    from before_new_readings p
    join public.industry_system_index_bucket b
      on b.bucket_hours = p.bucket_hours and b.system_id = p.system_id
     and b.activity = p.activity and b.bucket_at = p.bucket_at
   where b.ctid <> p.tid;
  assert rewritten <= 3, format('expected at most the 3 current buckets rewritten, got %s', rewritten);
end $$;

-- ── A refresh with nothing new writes nothing ─────────────────────────────
create temp table before_idle as
select bucket_hours, system_id, activity, bucket_at, ctid as tid
from public.industry_system_index_bucket;

select public.refresh_industry_index_buckets();

do $$
declare
  rewritten int;
  appeared int;
begin
  select count(*) into rewritten
    from before_idle p
    join public.industry_system_index_bucket b
      on b.bucket_hours = p.bucket_hours and b.system_id = p.system_id
     and b.activity = p.activity and b.bucket_at = p.bucket_at
   where b.ctid <> p.tid;
  select (select count(*) from public.industry_system_index_bucket) - (select count(*) from before_idle) into appeared;
  assert rewritten = 0 and appeared = 0,
    format('expected an idle refresh to write nothing, %s rewritten and %s added', rewritten, appeared);
end $$;

-- ── A late reading inside the margin is picked up ─────────────────────────
-- A run that committed after the next one refreshed: its reading is two hours
-- older than the newest hourly bucket, inside the three-hour margin.
insert into public.industry_system_index (system_id, activity, cost_index, recorded_at)
values (30000142, 'copying', 0.3, to_timestamp(floor(extract(epoch from now()) / 3600) * 3600) - interval '110 minutes');

select public.refresh_industry_index_buckets();

select pg_temp.assert_matches_reference('after a late reading');

-- ── A bucket that ages out is deleted ─────────────────────────────────────
-- Planted one hour behind the 1h width's retention: no reading backs it, and
-- the next refresh must drop it rather than keep it forever.
insert into public.industry_system_index_bucket (bucket_hours, system_id, activity, bucket_at, cost_index, recorded_at)
values (
  1, 30000999, 'reaction',
  to_timestamp(floor(extract(epoch from now() - interval '8 days') / 3600) * 3600) - interval '1 hour',
  0.1,
  to_timestamp(floor(extract(epoch from now() - interval '8 days') / 3600) * 3600) - interval '30 minutes'
);

select public.refresh_industry_index_buckets();

select pg_temp.assert_matches_reference('after ageing out');

-- ── Readers read, only the service role refreshes ─────────────────────────
do $$
begin
  assert has_table_privilege('anon', 'public.industry_system_index_bucket', 'select'),
    'anon should read the buckets, like the source table';
  assert not has_function_privilege('authenticated', 'public.refresh_industry_index_buckets()', 'execute'),
    'authenticated must not refresh the buckets';
  assert not has_function_privilege('anon', 'public.refresh_industry_index_buckets()', 'execute'),
    'anon must not refresh the buckets';
  assert has_function_privilege('service_role', 'public.refresh_industry_index_buckets()', 'execute'),
    'the industry-systems job (service role) must refresh the buckets';
end $$;

rollback;
