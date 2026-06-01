-- Idempotent migrations for an already-provisioned database. See
-- migrations/20260601_rename_character_to_registration_and_create_eve_name.sql
-- for the conventions. Safe to re-run.

-- The scheduled jobs (structures, assets, hourly, daily) now each write a row
-- to hangar.heartbeat when they finish, and the Structures/Assets pages read
-- back the most recent run per job. Add a (job, ran_at desc) index so that
-- "latest run of this job" lookup is an index scan, and open up read access to
-- the authenticated UI client (the table previously only granted service_role).

create index if not exists heartbeat_job_ran_at_idx
  on hangar.heartbeat (job, ran_at desc);

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'hangar'
      and tablename = 'heartbeat'
      and policyname = 'Authenticated read heartbeat'
  ) then
    create policy "Authenticated read heartbeat"
      on hangar.heartbeat
      for select
      to authenticated
      using (true);
  end if;
end $$;

grant select on hangar.heartbeat to authenticated;
grant all    on hangar.heartbeat to service_role;
