-- industry_system_index_bucket becomes a table the industry-systems job keeps
-- up to date one hour at a time, instead of a materialized view it rebuilt
-- whole every hour.
--
-- REFRESH MATERIALIZED VIEW CONCURRENTLY recomputes the entire view and then
-- diffs it against the old contents. Over 91 days of hourly readings that is
-- 1.35M rows (each 24h-retained reading counted once per width) folded into
-- 223K buckets — a hash aggregate that spills ~110 MB at this instance's
-- 3.5 MB work_mem — followed by a full join of the old and new contents that
-- spills again. pg_stat_statements over the 27.7 hours after the 2026-11-15
-- restart: 27 calls, 12.3 s each, 350K blocks read, 1.03M temp blocks written
-- and 674K read, 85 MB of WAL. One of the largest Disk IO consumers left after
-- 20261113234837.
--
-- Each hourly run changes only the buckets its new readings land in: for each
-- of ~630 (system, activity) series, the current 1h bucket and the current 6h
-- and 24h ones. refresh_industry_index_buckets() now recomputes just those —
-- every bucket from the newest hourly bucket already written (less a three-hour
-- margin for a run that committed late) — from the readings they cover, writes
-- the ones that differ, and deletes buckets that aged out. 247 buffers of
-- source rows and ~3K index probes against the table, no temp. Readers are
-- unchanged: same name, same columns, same unique key.
--
-- See schema.sql for the full comments; the bodies below are copied from it.

drop materialized view if exists public.industry_system_index_bucket;

create table public.industry_system_index_bucket (
  system_id bigint not null,
  bucket_at timestamptz not null,
  recorded_at timestamptz not null,
  cost_index real not null,
  bucket_hours smallint not null,
  activity text not null,
  constraint industry_system_index_bucket_uq primary key (bucket_hours, system_id, activity, bucket_at)
) with (fillfactor = 90);

create index industry_system_index_bucket_age_idx
  on public.industry_system_index_bucket (bucket_hours, bucket_at);

alter table public.industry_system_index_bucket enable row level security;
create policy "Everyone reads industry index buckets"
  on public.industry_system_index_bucket
  for select
  to anon, authenticated
  using (true);

grant select on public.industry_system_index_bucket to anon, authenticated;
grant all    on public.industry_system_index_bucket to service_role;

create or replace function public.refresh_industry_index_buckets()
returns void
language plpgsql
security definer
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
set work_mem = '16MB'
as $$
declare
  -- The oldest bucket each width keeps: the one holding the moment 8, 31 and
  -- 91 days ago.
  v_keep_1  timestamptz := to_timestamp(floor(extract(epoch from now() - interval '8 days') / 3600) * 3600);
  v_keep_6  timestamptz := to_timestamp(floor(extract(epoch from now() - interval '31 days') / 21600) * 21600);
  v_keep_24 timestamptz := to_timestamp(floor(extract(epoch from now() - interval '91 days') / 86400) * 86400);
  v_since   timestamptz;
  v_from_1  timestamptz;
  v_from_6  timestamptz;
  v_from_24 timestamptz;
begin
  perform pg_advisory_xact_lock(hashtext('public.refresh_industry_index_buckets'));

  select max(b.bucket_at) - interval '3 hours'
    into v_since
    from public.industry_system_index_bucket b
   where b.bucket_hours = 1;

  v_from_1  := greatest(v_keep_1,  to_timestamp(floor(extract(epoch from v_since) / 3600) * 3600));
  v_from_6  := greatest(v_keep_6,  to_timestamp(floor(extract(epoch from v_since) / 21600) * 21600));
  v_from_24 := greatest(v_keep_24, to_timestamp(floor(extract(epoch from v_since) / 86400) * 86400));

  insert into public.industry_system_index_bucket
    (bucket_hours, system_id, activity, bucket_at, cost_index, recorded_at)
  select f.bucket_hours, f.system_id, f.activity, f.bucket_at, f.cost_index, f.recorded_at
  from (
    select
      g.bucket_hours,
      i.system_id,
      i.activity,
      to_timestamp(floor(extract(epoch from i.recorded_at) / (g.bucket_hours * 3600)) * (g.bucket_hours * 3600)) as bucket_at,
      avg(i.cost_index)::real as cost_index,
      max(i.recorded_at) as recorded_at
    from public.industry_system_index i
    join (values (1::smallint, v_from_1), (6::smallint, v_from_6), (24::smallint, v_from_24)) as g (bucket_hours, from_at)
      on i.recorded_at >= g.from_at
    where i.recorded_at >= least(v_from_1, v_from_6, v_from_24)
    group by 1, 2, 3, 4
  ) f
  where not exists (
    select 1
      from public.industry_system_index_bucket b
     where b.bucket_hours = f.bucket_hours
       and b.system_id = f.system_id
       and b.activity = f.activity
       and b.bucket_at = f.bucket_at
       and b.cost_index = f.cost_index
       and b.recorded_at = f.recorded_at
  )
  on conflict (bucket_hours, system_id, activity, bucket_at) do update
    set cost_index = excluded.cost_index,
        recorded_at = excluded.recorded_at;

  delete from public.industry_system_index_bucket b
   where (b.bucket_hours = 1 and b.bucket_at < v_keep_1)
      or (b.bucket_hours = 6 and b.bucket_at < v_keep_6)
      or (b.bucket_hours = 24 and b.bucket_at < v_keep_24);
end
$$;

revoke execute on function public.refresh_industry_index_buckets() from public, anon, authenticated;
grant execute on function public.refresh_industry_index_buckets() to service_role;

-- The table starts empty, so the first call computes every retained bucket.
select public.refresh_industry_index_buckets();
