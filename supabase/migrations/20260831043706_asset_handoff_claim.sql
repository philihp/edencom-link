-- An item that changes hands must be expired from its previous owner, not
-- collided with.
--
-- ── The bug ───────────────────────────────────────────────────────────────
-- character_asset_over_time_current_item_idx is `unique (item_id) where
-- is_current` — one open row per item across the *whole table*, because an EVE
-- item_id names one real object in the universe and only one character can hold
-- it at a time. But every reconcile only ever looked at its own owner's rows:
--
--   .eq('registration_id', registration_id).eq('is_current', true)
--
-- So when an item moved between two characters (which happens constantly —
-- 14,738 item_ids in character_asset_over_time have been seen under more than
-- one registration, 10,137 in character_blueprint_over_time), the receiving
-- character saw no open row *for itself*, classified the item as new, and
-- inserted while the previous owner's row was still open. Duplicate key, and
-- the whole character's extract aborted:
--
--   duplicate key value violates unique constraint
--   "character_asset_over_time_current_item_idx"
--
-- 105 aborted runs since 2026-08-07, 19 in the last day. The comment the old
-- code carried — "Close before inserting so the unique-current-per-item index
-- never collides" — described the right intent; it just closed rows from a
-- lookup that could not see the other owner's.
--
-- Worse than the error: touch, close and insert ran as three separate
-- un-transacted statements, so an aborted insert left that owner's rows already
-- closed and never reopened until the next successful run. The
-- "bridge a container that momentarily dropped out of the current snapshot"
-- recursion in character_asset_location_summary() exists to paper over exactly
-- that hole.
--
-- ── The fix ───────────────────────────────────────────────────────────────
-- One claim function per table, replacing the close+insert pair. It closes any
-- open row for the incoming item_ids *whoever owns them* and inserts the new
-- versions in a single statement pair inside one transaction, so a handoff is
-- atomic: the item is expired from the old owner and opened under the new one,
-- or neither happens.
--
-- This does mean one registration's extract can close a row belonging to
-- another registration — including one on somebody else's account. That is the
-- intended semantics (the item really did leave them), and the only way to
-- reach it is a service-role extract reconciling what ESI reported for a token
-- that account authorized. See the grants at the bottom: these functions are
-- SECURITY INVOKER, so they carry no privilege of their own and an
-- authenticated caller reaching one still gets nothing.
--
-- ── Why the advisory lock ─────────────────────────────────────────────────
-- The per-character workflow runs characters concurrently across lanes, so two
-- lanes can claim the same item at the same moment. Closing and inserting
-- atomically is not enough on its own: under READ COMMITTED, a transaction that
-- runs its close before the other's insert commits cannot see that insert, and
-- collides anyway. A transaction-scoped advisory lock keyed on the table
-- serializes just the claim window — the ESI fetch and the classify pass stay
-- fully concurrent, and the locked section is one update plus one insert over a
-- batch that is usually a handful of rows.

-- ── character assets ──────────────────────────────────────────────────────
create or replace function public.character_asset_claim(p_rows jsonb)
returns integer
language plpgsql
security invoker
set search_path to 'public'
as $$
declare
  v_items    bigint[];
  v_inserted integer;
begin
  if p_rows is null or jsonb_array_length(p_rows) = 0 then
    return 0;
  end if;

  select array_agg(distinct (r->>'item_id')::bigint)
    into v_items
    from jsonb_array_elements(p_rows) r;

  perform pg_advisory_xact_lock(hashtext('public.character_asset_over_time')::bigint);

  -- The handoff. No registration_id predicate: whoever held it, they no longer
  -- do. valid_until is left where the previous owner's last sighting put it,
  -- matching how a vanished row is closed.
  update public.character_asset_over_time
     set is_current = false
   where is_current
     and item_id = any (v_items);

  insert into public.character_asset_over_time
    (item_id, registration_id, type_id, location_id, location_flag, location_type,
     quantity, is_singleton, is_blueprint_copy, valid_until, name)
  select (r->>'item_id')::bigint,
         (r->>'registration_id')::uuid,
         (r->>'type_id')::bigint,
         (r->>'location_id')::bigint,
         r->>'location_flag',
         r->>'location_type',
         (r->>'quantity')::bigint,
         (r->>'is_singleton')::boolean,
         coalesce((r->>'is_blueprint_copy')::boolean, false),
         coalesce((r->>'valid_until')::timestamptz, now()),
         r->>'name'
    from jsonb_array_elements(p_rows) r;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end
$$;

-- ── character blueprints ──────────────────────────────────────────────────
create or replace function public.character_blueprint_claim(p_rows jsonb)
returns integer
language plpgsql
security invoker
set search_path to 'public'
as $$
declare
  v_items    bigint[];
  v_inserted integer;
begin
  if p_rows is null or jsonb_array_length(p_rows) = 0 then
    return 0;
  end if;

  select array_agg(distinct (r->>'item_id')::bigint)
    into v_items
    from jsonb_array_elements(p_rows) r;

  perform pg_advisory_xact_lock(hashtext('public.character_blueprint_over_time')::bigint);

  update public.character_blueprint_over_time
     set is_current = false
   where is_current
     and item_id = any (v_items);

  insert into public.character_blueprint_over_time
    (item_id, registration_id, type_id, location_id, location_flag, quantity,
     material_efficiency, time_efficiency, runs, valid_until)
  select (r->>'item_id')::bigint,
         (r->>'registration_id')::uuid,
         (r->>'type_id')::bigint,
         (r->>'location_id')::bigint,
         r->>'location_flag',
         (r->>'quantity')::bigint,
         (r->>'material_efficiency')::smallint,
         (r->>'time_efficiency')::smallint,
         (r->>'runs')::integer,
         coalesce((r->>'valid_until')::timestamptz, now())
    from jsonb_array_elements(p_rows) r;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end
$$;

-- ── corp assets ───────────────────────────────────────────────────────────
-- Corp tables have not thrown this yet (203 and 199 shared item_ids
-- respectively, against 14,738 for characters) but the shape is identical: the
-- index is global on item_id, the lookup was scoped to one corporation_id.
create or replace function public.corp_asset_claim(p_rows jsonb)
returns integer
language plpgsql
security invoker
set search_path to 'public'
as $$
declare
  v_items    bigint[];
  v_inserted integer;
begin
  if p_rows is null or jsonb_array_length(p_rows) = 0 then
    return 0;
  end if;

  select array_agg(distinct (r->>'item_id')::bigint)
    into v_items
    from jsonb_array_elements(p_rows) r;

  perform pg_advisory_xact_lock(hashtext('public.corp_asset_over_time')::bigint);

  update public.corp_asset_over_time
     set is_current = false
   where is_current
     and item_id = any (v_items);

  insert into public.corp_asset_over_time
    (item_id, corporation_id, type_id, location_id, location_flag, location_type,
     quantity, is_singleton, is_blueprint_copy, valid_until)
  select (r->>'item_id')::bigint,
         (r->>'corporation_id')::bigint,
         (r->>'type_id')::bigint,
         (r->>'location_id')::bigint,
         r->>'location_flag',
         r->>'location_type',
         (r->>'quantity')::bigint,
         (r->>'is_singleton')::boolean,
         coalesce((r->>'is_blueprint_copy')::boolean, false),
         coalesce((r->>'valid_until')::timestamptz, now())
    from jsonb_array_elements(p_rows) r;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end
$$;

-- ── corp blueprints ───────────────────────────────────────────────────────
create or replace function public.corp_blueprint_claim(p_rows jsonb)
returns integer
language plpgsql
security invoker
set search_path to 'public'
as $$
declare
  v_items    bigint[];
  v_inserted integer;
begin
  if p_rows is null or jsonb_array_length(p_rows) = 0 then
    return 0;
  end if;

  select array_agg(distinct (r->>'item_id')::bigint)
    into v_items
    from jsonb_array_elements(p_rows) r;

  perform pg_advisory_xact_lock(hashtext('public.corp_blueprint_over_time')::bigint);

  update public.corp_blueprint_over_time
     set is_current = false
   where is_current
     and item_id = any (v_items);

  insert into public.corp_blueprint_over_time
    (item_id, corporation_id, type_id, location_id, location_flag, quantity,
     material_efficiency, time_efficiency, runs, valid_until)
  select (r->>'item_id')::bigint,
         (r->>'corporation_id')::bigint,
         (r->>'type_id')::bigint,
         (r->>'location_id')::bigint,
         r->>'location_flag',
         (r->>'quantity')::bigint,
         (r->>'material_efficiency')::smallint,
         (r->>'time_efficiency')::smallint,
         (r->>'runs')::integer,
         coalesce((r->>'valid_until')::timestamptz, now())
    from jsonb_array_elements(p_rows) r;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end
$$;

-- ── Who may call these ────────────────────────────────────────────────────
-- schema.sql still hands new functions EXECUTE to anon/authenticated by default
-- (`alter default privileges ... grant all on functions`), and Postgres grants
-- EXECUTE to PUBLIC on top of that, so each one has to claw it back the way
-- ensure_sde_mirror_table() does.
--
-- These are SECURITY INVOKER, so the revoke is defence in depth rather than the
-- control itself: a caller who somehow reached one would still be executing the
-- update and insert as their own role, and anon/authenticated hold neither
-- INSERT nor UPDATE on any of the four tables. The service role is the only
-- role that carries those, which is what makes "a reconcile can expire another
-- account's row" safe to allow at all.
revoke execute on function public.character_asset_claim(jsonb)     from public, anon, authenticated;
revoke execute on function public.character_blueprint_claim(jsonb) from public, anon, authenticated;
revoke execute on function public.corp_asset_claim(jsonb)          from public, anon, authenticated;
revoke execute on function public.corp_blueprint_claim(jsonb)      from public, anon, authenticated;

grant execute on function public.character_asset_claim(jsonb)     to service_role;
grant execute on function public.character_blueprint_claim(jsonb) to service_role;
grant execute on function public.corp_asset_claim(jsonb)          to service_role;
grant execute on function public.corp_blueprint_claim(jsonb)      to service_role;

-- ── TRUNCATE: the half of the write surface 20260809090000 missed ─────────
-- That migration revoked insert, update and delete from anon/authenticated
-- across every table with no write policy, and reset the default privileges.
-- It did not revoke TRUNCATE, which the blanket `grant all on tables` had also
-- handed out — so every one of these tables still reads
--
--   anon=rDxt/postgres   authenticated=rDxt/postgres
--
-- where D is TRUNCATE. TRUNCATE is not row-level, so RLS — the thing standing
-- between the anon key and the rest of that grant — does not gate it at all: a
-- single statement empties the table for everyone. Nothing in PostgREST issues
-- TRUNCATE today, so this is a latent hole rather than a live one, but it is
-- the one remaining verb on these tables that RLS cannot answer for.
--
-- REFERENCES and TRIGGER go with it: neither is used by anything, and both let
-- a role attach objects to a table it cannot write.
--
-- Same DO-block shape and same reasoning as 20260809090000 — a list would miss
-- the sde_* tables minted at runtime by ensure_sde_mirror_table(). SELECT is
-- deliberately untouched.
do $$
declare r record;
begin
  for r in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and (
        has_table_privilege('anon', c.oid, 'TRUNCATE')
        or has_table_privilege('anon', c.oid, 'REFERENCES')
        or has_table_privilege('anon', c.oid, 'TRIGGER')
        or has_table_privilege('authenticated', c.oid, 'TRUNCATE')
        or has_table_privilege('authenticated', c.oid, 'REFERENCES')
        or has_table_privilege('authenticated', c.oid, 'TRIGGER')
      )
  loop
    execute format('revoke truncate, references, trigger on public.%I from anon, authenticated', r.relname);
  end loop;
end $$;
