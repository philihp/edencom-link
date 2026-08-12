-- Ask PostgREST to reload its schema cache when ensure_sde_mirror_table()
-- actually mints a table.
--
-- The ingest creates a table over SQL (this function, an RPC) and then writes
-- its first rows over PostgREST, which answers from a cached schema. A table
-- PostgREST has not reloaded yet is simply absent:
--
--   sde-mirror: upsert into sde_schools failed:
--   Could not find the table 'public.sde_schools' in the schema cache
--
-- which is exactly how the nightly mirror has been dying — one new table per
-- run, each night getting one file further before hitting the next new one.
--
-- The reload notification used to arrive as a side effect: before
-- 20260809070000 this function re-applied its whole shape on every call, so the
-- DDL fired Supabase's ddl_command_end watcher ~560 times a night and kept the
-- cache hot. Making the body a genuine no-op for existing tables — the right
-- fix for the lock and pg_graphql churn — removed the accidental reload with
-- it, and the race stopped being papered over.
--
-- So ask explicitly, and only when a table was really created. NOTIFY is
-- transactional (delivered at commit) and the reload itself is asynchronous, so
-- this shortens the window rather than closing it; the ingest also retries on
-- PGRST205 (upsertChunk in src/jobs/sdeMirror.js), which is what actually
-- guarantees the write lands.
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
    -- New table: PostgREST cannot write to what it cannot see.
    notify pgrst, 'reload schema';
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

-- Catch the mirror up in one shot rather than one table per night: mint every
-- sde_* table the current export needs that does not exist yet, so the next run
-- starts with PostgREST already able to see them. Only the tables this schema
-- already names — a genuinely new CCP file is still minted at ingest, which is
-- what the notify + retry above is for.
select public.ensure_sde_mirror_table(stem)
from unnest(
  array['types', 'groups', 'categories', 'map_solar_systems', 'map_constellations', 'map_regions',
        'npc_stations', 'blueprints', 'map_planets']
) as stem;
