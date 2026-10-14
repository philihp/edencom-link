-- SQL-level coverage for industry_index_tracked_systems(): the distinct set of
-- systems the industry-systems job keeps recording once they have any history.
--
-- Run against a THROWAWAY database from the repo root:
--
--   DATABASE_URL='postgresql://…/throwaway' pnpm run test:sql
--
-- Everything runs inside one transaction and rolls back.
begin;

do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin; exception when duplicate_object then null; end $$;

create table public.industry_system_index (
  id bigint generated always as identity primary key,
  system_id bigint not null,
  activity text not null,
  cost_index real not null,
  recorded_at timestamptz not null default now()
);
create index industry_system_index_system_activity_idx
  on public.industry_system_index (system_id, activity, recorded_at desc);

\i supabase/migrations/20261014220134_industry_index_tracked_systems.sql

do $$
declare
  got bigint[];
begin
  -- Empty history: no systems, not a null row.
  select coalesce(array_agg(s), '{}') into got from public.industry_index_tracked_systems() s;
  if got <> '{}' then raise exception 'expected no systems on an empty table, got %', got; end if;

  -- Three systems, several activities and hours each, inserted out of order.
  insert into public.industry_system_index (system_id, activity, cost_index, recorded_at) values
    (30000142, 'manufacturing', 0.05, '2026-10-01T00:00:00Z'),
    (30000142, 'reaction',      0.01, '2026-10-01T00:00:00Z'),
    (30002187, 'manufacturing', 0.02, '2026-10-01T00:00:00Z'),
    (30000142, 'manufacturing', 0.06, '2026-10-01T01:00:00Z'),
    (30004759, 'copying',       0.03, '2026-09-01T00:00:00Z'),
    (30002187, 'manufacturing', 0.02, '2026-10-01T01:00:00Z');

  -- Each system once, ascending, however many rows it has.
  select array_agg(s order by s) into got from public.industry_index_tracked_systems() s;
  if got <> array[30000142, 30002187, 30004759]::bigint[] then
    raise exception 'expected the three distinct systems, got %', got;
  end if;
  if (select count(*) from public.industry_index_tracked_systems()) <> 3 then
    raise exception 'a system must be listed exactly once';
  end if;
end $$;

-- Service-role only, like the bucket refresh beside it.
do $$
begin
  set local role anon;
  begin
    perform public.industry_index_tracked_systems();
    raise exception 'anon must not be able to call industry_index_tracked_systems()';
  exception when insufficient_privilege then null;
  end;
  reset role;
end $$;

rollback;
