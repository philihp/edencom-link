-- One-time baseline: relocate every object created under the old `hangar`
-- schema into `public`. The app and schema.sql now live entirely in `public`,
-- which PostgREST exposes without the "Exposed schemas" dashboard step.
--
-- The all-zero prefix makes this sort before the dated migrations so that, on
-- the run that performs the move, the tables are already in `public` before
-- those (now public-targeting) migrations touch them. Idempotent: once
-- `hangar` is empty the loops are no-ops, so it is safe on fresh installs
-- (where `hangar` never existed) and on every re-run. Safe to re-run.

do $$
declare
  obj record;
begin
  -- Tables first; SET SCHEMA carries each table's indexes, constraints, RLS
  -- policies, grants, and identity-owned sequences along with it.
  for obj in
    select tablename from pg_tables where schemaname = 'hangar'
  loop
    execute format('alter table hangar.%I set schema public', obj.tablename);
  end loop;

  -- Any standalone sequences not already moved with their owning table.
  for obj in
    select sequencename from pg_sequences where schemaname = 'hangar'
  loop
    execute format('alter sequence hangar.%I set schema public', obj.sequencename);
  end loop;

  -- Views (e.g. the `asset` current-only view) after their base tables.
  for obj in
    select viewname from pg_views where schemaname = 'hangar'
  loop
    execute format('alter view hangar.%I set schema public', obj.viewname);
  end loop;
end $$;

-- Drop the now-empty schema. RESTRICT makes this fail (and be skipped) if any
-- object unexpectedly remains, so we never silently destroy data.
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'hangar') then
    begin
      execute 'drop schema hangar restrict';
    exception
      when dependent_objects_still_exist then
        raise notice 'hangar schema not empty; leaving it in place';
    end;
  end if;
end $$;
