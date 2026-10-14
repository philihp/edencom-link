-- industry_index_tracked_systems(): every solar system that has ever had a
-- cost index recorded. The industry-systems job unions this into the set it
-- records each hour, so a system keeps accruing history once anyone has
-- tracked it — unwatching it, unanchoring the structure or the job that ran
-- there ageing out no longer leaves a hole in its chart.
--
-- industry_system_index is append-only and grows ~150 rows an hour, so a plain
-- `select distinct system_id` is a full scan that gets slower every day.
-- Postgres has no loose index scan, so this walks (system_id, activity,
-- recorded_at desc) by hand: each step asks the btree for the smallest
-- system_id above the last one, one index probe per distinct system.
create or replace function public.industry_index_tracked_systems()
returns setof bigint
language sql
stable
security definer
set search_path = ''
as $$
  with recursive skip (system_id) as (
    (select system_id from public.industry_system_index order by system_id limit 1)
    union all
    select (
      select i.system_id
      from public.industry_system_index i
      where i.system_id > skip.system_id
      order by i.system_id
      limit 1
    )
    from skip
    where skip.system_id is not null
  )
  select system_id from skip where system_id is not null
$$;

revoke execute on function public.industry_index_tracked_systems() from public, anon, authenticated;
grant execute on function public.industry_index_tracked_systems() to service_role;
