-- Tracks an on-demand "Refresh ESI" run (the button on /character). One row per
-- dispatched unit of work: per character for the per-character jobs (assets,
-- hourly, structures, orders) and one account-wide row for daily. The server
-- action inserts these (status 'pending') and enqueues a matching queue message;
-- the queue consumer flips each to 'running' then 'done'/'error'. The
-- /characters/refresh page reads them (scoped to the owner) to show live status.
create table if not exists public.refresh_task (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  job text not null,
  character_id uuid references public.registration(id) on delete cascade,
  character_name text,
  status text not null default 'pending',
  started_at timestamptz,
  ended_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists refresh_task_batch_id_idx on public.refresh_task (batch_id);
create index if not exists refresh_task_user_id_created_at_idx on public.refresh_task (user_id, created_at desc);

alter table public.refresh_task enable row level security;
create policy "Users read own refresh tasks"
  on public.refresh_task
  for select
  to authenticated
  using (user_id = (select auth.uid()));

grant select on public.refresh_task to authenticated;
grant all    on public.refresh_task to service_role;
