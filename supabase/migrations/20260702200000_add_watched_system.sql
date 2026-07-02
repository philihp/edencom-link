-- Per-user list of solar systems to watch industry cost indices for. The
-- industry-systems extract pulls the union of every user's watched systems
-- (plus the systems we hold structures in) each run, and the /indexes page
-- renders one sparkline row per watched system.
create table public.watched_system (
  user_id uuid not null references auth.users(id) on delete cascade,
  system_id bigint not null,
  created_at timestamptz not null default now(),
  primary key (user_id, system_id)
);
create index watched_system_user_id_idx on public.watched_system (user_id);

alter table public.watched_system enable row level security;
create policy "Users manage own watched systems"
  on public.watched_system
  for all
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

grant select, insert, update, delete on public.watched_system to authenticated;
grant all                            on public.watched_system to service_role;
