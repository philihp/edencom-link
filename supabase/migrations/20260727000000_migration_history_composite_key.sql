-- Let the migration history hold two migrations that share a timestamp.
--
-- supabase_migrations.schema_migrations ships with `primary key (version)`,
-- where version is the migration filename's leading timestamp. Two migration
-- files minted in the same second therefore can't both be recorded: the first
-- one applies, and every later `supabase db push` dies re-inserting the second —
--
--   ERROR: duplicate key value violates unique constraint "schema_migrations_pkey"
--   Key (version)=(20260723020000) already exists.
--
-- which blocks not just the colliding pair but every migration behind them. That
-- happened twice here: 20260723020000 (add_sheet_csv / character_skill) and
-- 20260725000000 (blueprint_search / mercenary_den_alliance_sharing), and it
-- held the queue up for two days.
--
-- Production was repaired by hand — its primary key is already
-- (version, name) — so this migration codifies that state and carries it to
-- every other database. Widening the key rather than renaming files keeps us
-- clear of the rule in CLAUDE.md against renaming migrations, and fixes the
-- whole class of collision instead of the two instances we happen to have.
--
-- **What this does and doesn't rescue.** It is numbered after both existing
-- collisions, per the ordering guard in .github/scripts/check-migrations.mjs, so
-- it cannot rescue a from-scratch replay of the current history — such a replay
-- still wedges at 20260723020000 with the stock key. What it does close is the
-- case that guard structurally cannot catch: two *open* PRs carrying the same
-- new timestamp both pass the check against main, then collide on merge. That's
-- exactly how both existing pairs happened. Once this has run, a future
-- same-second pair records cleanly instead of wedging the pipeline.
--
-- Not mirrored into schema.sql: that file is the source of truth for the
-- `public` schema only, and supabase_migrations is CLI-owned bookkeeping.
--
-- Idempotent: re-running is a no-op once the key includes `name`.

do $$
declare
  v_pk_name text;
  v_key_has_name boolean;
  v_null_names bigint;
begin
  -- Nothing to align if the history table isn't there yet (it's created by the
  -- CLI before the first migration runs, so this is belt-and-braces).
  if to_regclass('supabase_migrations.schema_migrations') is null then
    raise notice 'supabase_migrations.schema_migrations not present; skipping';
    return;
  end if;

  select c.conname,
         exists (
           select 1
           from unnest(c.conkey) as k(attnum)
           join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
           where a.attname = 'name'
         )
    into v_pk_name, v_key_has_name
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
   where n.nspname = 'supabase_migrations'
     and t.relname = 'schema_migrations'
     and c.contype = 'p';

  if v_pk_name is null then
    -- No primary key at all: not a shape we recognise, so don't guess.
    raise notice 'schema_migrations has no primary key; leaving it alone';
    return;
  end if;

  if v_key_has_name then
    -- Already (version, name) — the production shape. Nothing to do.
    return;
  end if;

  -- `name` is about to become part of the key, so it has to be non-null. Every
  -- row written by a current CLI carries one; if some don't, that's history we
  -- can't reconstruct, and inventing values would risk making the CLI re-apply
  -- those migrations. Fail loudly instead of quietly mangling the bookkeeping.
  select count(*) into v_null_names
    from supabase_migrations.schema_migrations
   where name is null;

  if v_null_names > 0 then
    raise exception
      'cannot widen schema_migrations primary key: % row(s) have a null name. '
      'Set each to its migration filename (the part after the timestamp) and re-run.',
      v_null_names;
  end if;

  execute format('alter table supabase_migrations.schema_migrations drop constraint %I', v_pk_name);
  alter table supabase_migrations.schema_migrations add primary key (version, name);

  raise notice 'schema_migrations primary key widened to (version, name)';
end
$$;
