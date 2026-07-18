-- Storage for the eveship.fit protobuf data (the 6 files @eveshipfit/react's
-- EveDataProvider reads). Phase 1 of moving esf:build off the build (docs/
-- sde-db-cutover/04-esf-workflow.md): the sde-mirror workflow encodes the .pb2
-- from the sde_* mirror after each SDE build and upserts them here, so the
-- data refreshes when the SDE changes without a redeploy. Phase 2 adds a route
-- that serves these rows at /esf-data/ and retires the build-time static files.
--
-- `data` holds the base64-encoded protobuf bytes (text is far simpler to move
-- through PostgREST than bytea; the serving route base64-decodes it). Public
-- read (the .pb2 are non-sensitive static game data, same as the sde_* mirror);
-- writes are service-role only (the workflow).
create table public.esf_data (
  name text primary key,
  data text not null,
  sde_build bigint not null,
  updated_at timestamptz not null default now()
);

alter table public.esf_data enable row level security;
create policy "Everyone reads esf data"
  on public.esf_data
  for select
  to anon, authenticated
  using (true);

grant select on public.esf_data to anon, authenticated;
grant all    on public.esf_data to service_role;
