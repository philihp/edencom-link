-- Make ensure_sde_mirror_table() a genuine no-op when the table is already
-- correct, instead of re-applying its whole shape on every call.
--
-- The previous body guarded only the CREATE TABLE; the six statements after it
-- ran unconditionally:
--
--   create table if not exists ...            -- no-op once it exists
--   alter table ... enable row level security -- ran every call
--   drop policy if exists ...                 -- ran every call
--   create policy ...                         -- ran every call
--   grant select ...                          -- ran every call
--   revoke insert, update, delete ...         -- ran every call
--   grant select, insert, update, delete ...  -- ran every call
--
-- sde-mirror calls this once per JSONL file, so at 80 mirror tables that is
-- ~560 DDL statements per nightly run to arrive at a state the database was
-- already in. Two costs follow from that:
--
--   * ALTER TABLE ... ENABLE ROW LEVEL SECURITY and CREATE POLICY each take an
--     ACCESS EXCLUSIVE lock on the table. Every run therefore briefly
--     exclusive-locks all 80 sde_* tables — the tables every page hit reads to
--     resolve type, system, station and planet names.
--   * pg_graphql's graphql_watch_ddl event trigger calls
--     graphql.increment_schema_version() on ddl_command_end without inspecting
--     whether the DDL changed anything reflected, so each of those statements
--     invalidates the cached GraphQL schema and forces a re-reflection on the
--     next GraphQL request.
--
-- The fix is at the source rather than in the event trigger. pg_graphql's
-- triggers are extension-owned, so disabling or replacing them means a
-- platform-side extension upgrade can silently restore them, and the failure
-- mode there is a *stale* GraphQL schema (new tables invisible, queries 404) —
-- worse and far less visible than a slow one. Removing the spurious DDL fixes
-- both costs and leaves the extension untouched.
--
-- Each step is now guarded by a catalog lookup, which is free next to the DDL
-- it replaces. Real migrations still bump the GraphQL schema version, because
-- they are real changes.
--
-- Drift repair is preserved. The old unconditional drop-and-recreate doubled as
-- self-healing if a policy or grant were ever changed by hand, so the policy
-- check compares the full shape (SELECT, permissive, applies to PUBLIC, a bare
-- `true` qualifier) rather than merely testing that the name exists — a policy
-- that has drifted in definition is still dropped and recreated.
create or replace function public.ensure_sde_mirror_table(p_stem text, p_key_type text default 'bigint')
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_table text;
  v_oid oid;
begin
  if p_stem !~ '^[a-z][a-z0-9_]{0,58}$' then
    raise exception 'invalid SDE mirror table stem: %', p_stem;
  end if;
  if p_key_type not in ('bigint', 'text') then
    raise exception 'invalid SDE mirror key type: %', p_key_type;
  end if;
  v_table := 'sde_' || p_stem;
  v_oid := to_regclass('public.' || quote_ident(v_table));

  if v_oid is null then
    execute format(
      'create table public.%I (_key %s primary key, data jsonb not null, sde_build bigint not null)',
      v_table,
      p_key_type
    );
    v_oid := to_regclass('public.' || quote_ident(v_table));
  end if;

  if not exists (
    select 1 from pg_catalog.pg_class c where c.oid = v_oid and c.relrowsecurity
  ) then
    execute format('alter table public.%I enable row level security', v_table);
  end if;

  -- Full-shape comparison, not just the name: a hand-altered policy still gets
  -- dropped and recreated, matching the old unconditional behaviour.
  if not exists (
    select 1
    from pg_catalog.pg_policy p
    where p.polrelid = v_oid
      and p.polname = 'Anyone reads SDE data'
      and p.polcmd = 'r'
      and p.polpermissive
      and p.polroles = '{0}'::oid[]
      and pg_catalog.pg_get_expr(p.polqual, p.polrelid) = 'true'
  ) then
    execute format('drop policy if exists "Anyone reads SDE data" on public.%I', v_table);
    execute format('create policy "Anyone reads SDE data" on public.%I for select using (true)', v_table);
  end if;

  if not (
    pg_catalog.has_table_privilege('anon', v_oid, 'select')
    and pg_catalog.has_table_privilege('authenticated', v_oid, 'select')
  ) then
    execute format('grant select on public.%I to anon, authenticated', v_table);
  end if;

  -- The schema's default privileges hand new tables ALL to anon/authenticated;
  -- claw the write privileges back so the mirror is read-only at the grant
  -- layer too, not just via the missing write policies.
  if pg_catalog.has_table_privilege('anon', v_oid, 'insert')
     or pg_catalog.has_table_privilege('anon', v_oid, 'update')
     or pg_catalog.has_table_privilege('anon', v_oid, 'delete')
     or pg_catalog.has_table_privilege('authenticated', v_oid, 'insert')
     or pg_catalog.has_table_privilege('authenticated', v_oid, 'update')
     or pg_catalog.has_table_privilege('authenticated', v_oid, 'delete') then
    execute format('revoke insert, update, delete on public.%I from anon, authenticated', v_table);
  end if;

  if not (
    pg_catalog.has_table_privilege('service_role', v_oid, 'select')
    and pg_catalog.has_table_privilege('service_role', v_oid, 'insert')
    and pg_catalog.has_table_privilege('service_role', v_oid, 'update')
    and pg_catalog.has_table_privilege('service_role', v_oid, 'delete')
  ) then
    execute format('grant select, insert, update, delete on public.%I to service_role', v_table);
  end if;
end
$$;

revoke execute on function public.ensure_sde_mirror_table(text, text) from public, anon, authenticated;
grant execute on function public.ensure_sde_mirror_table(text, text) to service_role;
