-- Idempotent migrations for an already-provisioned database. See
-- migrations/20260601_rename_character_to_registration_and_create_eve_name.sql
-- for the conventions. Safe to re-run.

-- The scheduled workflows (structures, assets, hourly, daily) now record one
-- heartbeat row per run: a 'start' step stamps started_at before the job and an
-- 'end' step stamps ended_at after, both keyed on the GitHub Actions run so they
-- update the same row, which also stores a link back to that run. Add the new
-- columns, the indexes that back start/end pairing and the UI's "latest
-- completion per job" lookup, and open read access to the authenticated UI
-- client (the table previously only granted service_role).

alter table public.heartbeat add column if not exists run_id bigint;
alter table public.heartbeat add column if not exists run_attempt integer;
alter table public.heartbeat add column if not exists run_url text;
alter table public.heartbeat add column if not exists started_at timestamptz;
alter table public.heartbeat add column if not exists ended_at timestamptz;

create unique index if not exists heartbeat_run_idx
  on public.heartbeat (job, run_id, run_attempt);
create index if not exists heartbeat_job_ended_at_idx
  on public.heartbeat (job, ended_at desc);

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'heartbeat'
      and policyname = 'Authenticated read heartbeat'
  ) then
    create policy "Authenticated read heartbeat"
      on public.heartbeat
      for select
      to authenticated
      using (true);
  end if;
end $$;

grant select on public.heartbeat to authenticated;
grant all    on public.heartbeat to service_role;
