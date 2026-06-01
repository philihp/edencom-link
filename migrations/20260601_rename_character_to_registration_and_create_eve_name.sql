-- Idempotent migrations for an already-provisioned database. hangar.sql is the
-- canonical schema for a fresh install but isn't re-runnable wholesale (it has
-- plain `create table` statements), so incremental changes to an existing DB
-- live here and are applied by the Migrate workflow. Safe to re-run.

-- PR #359: the linked-accounts table was renamed character -> registration.
-- Postgres carries the foreign keys, RLS policy expressions, and grants across
-- the rename automatically; only rename if it hasn't happened yet.
do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'hangar' and table_name = 'character'
  ) then
    alter table hangar.character rename to registration;
  end if;
end $$;

-- #338: eve_name was added to hangar.sql but never applied, so the daily job
-- fails with `relation "hangar.eve_name" does not exist`. Create it.
create table if not exists hangar.eve_name (
  id bigint primary key,
  name text not null,
  category text not null,
  resolved_at timestamptz not null default now()
);

alter table hangar.eve_name enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'hangar'
      and tablename = 'eve_name'
      and policyname = 'Authenticated read eve_name'
  ) then
    create policy "Authenticated read eve_name"
      on hangar.eve_name
      for select
      to authenticated
      using (true);
  end if;
end $$;

grant select on hangar.eve_name to authenticated;
grant all    on hangar.eve_name to service_role;
