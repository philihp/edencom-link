-- Rename character_blueprint_over_time.character_id to registration_id — fifth
-- tranche of step 5 of docs/registration-id-rename.md, and the last before
-- assets.
--
-- New here: this family's functions read the VIEW, not the table. Every
-- previous tranche had its function selecting straight from the _over_time
-- table, so the view and the function were independent recreations. Here the
-- view must be dropped and recreated FIRST, because both functions resolve
-- `character_blueprint` when their bodies are parsed and would otherwise bind
-- against a view still publishing the old name. The ordering below is
-- load-bearing, not cosmetic.
--
-- Also new: two functions, not one. character_blueprints() is here;
-- blueprint_search() — the ~200-line MCP list_blueprints RPC — is redefined in
-- the migration that immediately follows this one. It is split out rather than
-- inlined here because test/sql/blueprint_search.sql builds stand-in tables and
-- then `\i`-includes the migration that defines that function, so it has to
-- stay in a file containing nothing but the function and its grant.
--
-- Both functions are reproduced verbatim from schema.sql rather than
-- hand-edited, so a migrated database and a from-scratch reset cannot disagree
-- about a function that size. As in #759/#760 their `character_ids` PARAMETERS
-- stay — that is step 7, which ships with every RPC call site at once.

alter table public.character_blueprint_over_time rename column character_id to registration_id;

alter index if exists public.character_blueprint_over_time_character_id_idx
  rename to character_blueprint_over_time_registration_id_idx;

-- First: the view, since both functions read it.
drop view if exists public.character_blueprint;
create view public.character_blueprint with (security_invoker = on) as
  select * from public.character_blueprint_over_time where is_current;
grant select on public.character_blueprint to authenticated;

create or replace function public.character_blueprints(character_ids uuid[])
returns json
language sql
stable
as $$
  select coalesce(
    json_agg(
      json_build_object(
        'item_id',             b.item_id,
        'location_flag',       b.location_flag,
        'location_id',         b.location_id,
        'material_efficiency', b.material_efficiency,
        'quantity',            b.quantity,
        'runs',                b.runs,
        'time_efficiency',     b.time_efficiency,
        'type_id',             b.type_id,
        'character_name',      r.name,
        'type_name',           t.name
      )
      order by b.item_id
    ),
    '[]'::json
  )
  from public.character_blueprint b
  join public.registration r on r.id = b.registration_id
  left join public.sde_published_type t on t.type_id = b.type_id
  where b.registration_id = any(character_ids);
$$;

grant execute on function public.character_blueprints(uuid[]) to service_role;

-- Assert the view and this function's body. blueprint_search() is asserted in
-- the next migration, after it has been redefined — checking it here would fire
-- against the version this migration hasn't replaced yet.
do $$
declare
  def text;
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'character_blueprint'
      and column_name = 'character_id'
  ) then
    raise exception 'view character_blueprint still publishes character_id after the rename';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'character_blueprint'
      and column_name = 'registration_id'
  ) then
    raise exception 'view character_blueprint does not publish registration_id';
  end if;

  select pg_get_functiondef(p.oid) into def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'character_blueprints';

  if def is null then
    raise exception 'function public.character_blueprints() is missing after the rename';
  end if;
  if def like '%b.character_id%' then
    raise exception
      'character_blueprints() body still references b.character_id — it would fail at its next call, not here';
  end if;
  if def not like '%b.registration_id%' then
    raise exception 'character_blueprints() body does not reference b.registration_id';
  end if;
  -- Renaming the parameter is step 7's job; losing it here breaks every caller,
  -- since supabase-js passes RPC arguments by name.
  if def not like '%character_ids%' then
    raise exception 'character_blueprints() lost its character_ids parameter';
  end if;
end $$;
