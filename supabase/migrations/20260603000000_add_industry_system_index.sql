-- History of EVE's per-system industry cost indices, snapshotted each structures
-- run for every solar system we have a structure anchored in. Public ESI data
-- (/industry/systems/), so it's readable by everyone. Append-only so the indices'
-- drift over time can be charted. Mirrors the definition in schema.sql, written
-- idempotently so it is safe to apply to databases that already have the table.
create table if not exists public.industry_system_index (
  id bigint generated always as identity primary key,
  system_id bigint not null,
  activity text not null,
  cost_index real not null,
  recorded_at timestamptz not null default now()
);
create index if not exists industry_system_index_system_activity_idx
  on public.industry_system_index (system_id, activity, recorded_at desc);

alter table public.industry_system_index enable row level security;

drop policy if exists "Everyone reads industry indexes" on public.industry_system_index;
create policy "Everyone reads industry indexes"
  on public.industry_system_index
  for select
  to anon, authenticated
  using (true);

grant select on public.industry_system_index to anon, authenticated;
grant all    on public.industry_system_index to service_role;
