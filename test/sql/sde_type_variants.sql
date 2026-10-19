-- SQL-level coverage for sde_type_variants(): a type's variation family with
-- each member's meta level and tier, the data behind MCP module_variants.
--
-- Run against a THROWAWAY database from the repo root:
--
--   DATABASE_URL='postgresql://…/throwaway' pnpm run test:sql
--
-- Everything runs inside one transaction and rolls back. The stand-in
-- ensure_sde_mirror_table() mints the same (_key, data) shape the real one does.
begin;

do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin; exception when duplicate_object then null; end $$;

create function public.ensure_sde_mirror_table(p_stem text, p_key_type text default 'bigint')
returns void language plpgsql as $$
begin
  execute format(
    'create table if not exists public.%I (_key %s primary key, data jsonb not null, sde_build bigint)',
    'sde_' || p_stem, p_key_type
  );
  execute format('grant select on public.%I to anon, authenticated', 'sde_' || p_stem);
end
$$;
select public.ensure_sde_mirror_table('types');

\i supabase/migrations/20261019070830_sde_type_variants.sql

insert into public.sde_meta_groups (_key, data) values
  (1, '{"name": {"en": "Tech I"}}'),
  (2, '{"name": {"en": "Tech II"}}'),
  (4, '{"name": {"en": "Faction"}}');

-- The Damage Control family as CCP ships it: the root names no parent and no
-- meta group; every variant names the root. Plus an unpublished variant, a
-- nameless one, an unrelated family, and a type with no family at all.
insert into public.sde_types (_key, data) values
  (2046,  '{"name": {"en": "Damage Control I"}, "groupID": 60, "published": true}'),
  (2048,  '{"name": {"en": "Damage Control II"}, "groupID": 60, "published": true, "metaGroupID": 2, "variationParentTypeID": 2046}'),
  (5839,  '{"name": {"en": "IFFA Compact Damage Control"}, "groupID": 60, "published": true, "metaGroupID": 1, "variationParentTypeID": 2046}'),
  (99901, '{"name": {"en": "Republic Fleet Damage Control"}, "groupID": 60, "published": true, "metaGroupID": 4, "variationParentTypeID": 2046}'),
  (99902, '{"name": {"en": "Prototype Damage Control"}, "groupID": 60, "published": false, "metaGroupID": 1, "variationParentTypeID": 2046}'),
  (99903, '{"name": {"en": " "}, "groupID": 60, "published": true, "variationParentTypeID": 2046}'),
  (3001,  '{"name": {"en": "Shield Extender I"}, "groupID": 38, "published": true}'),
  (3002,  '{"name": {"en": "Shield Extender II"}, "groupID": 38, "published": true, "metaGroupID": 2, "variationParentTypeID": 3001}'),
  (34,    '{"name": {"en": "Tritanium"}, "groupID": 18, "published": true}');

-- metaLevel is attribute 633; values arrive as JSON numbers, sometimes floats.
-- Damage Control I carries no 633 at all, as plain Tech I types often do not.
insert into public.sde_type_dogma (_key, data) values
  (2046,  '{"dogmaAttributes": [{"attributeID": 30, "value": 1}]}'),
  (2048,  '{"dogmaAttributes": [{"attributeID": 30, "value": 1}, {"attributeID": 633, "value": 5.0}]}'),
  (5839,  '{"dogmaAttributes": [{"attributeID": 633, "value": 1}]}'),
  (99901, '{"dogmaAttributes": [{"attributeID": 633, "value": 8}]}'),
  (99902, '{"dogmaAttributes": [{"attributeID": 633, "value": 3}]}'),
  (3002,  '{"dogmaAttributes": [{"attributeID": 633, "value": 5}]}');

do $$
declare
  ids bigint[];
  r record;
begin
  -- Asked from a variant: the whole family, root included, by meta level.
  select array_agg(type_id order by ordinality) into ids
  from public.sde_type_variants(2048) with ordinality;
  if ids <> array[2046, 5839, 99902, 2048, 99901]::bigint[] then
    raise exception 'family of Damage Control II, by meta level: got %', ids;
  end if;

  -- Asked from the root: the same family.
  select array_agg(type_id order by ordinality) into ids
  from public.sde_type_variants(2046) with ordinality;
  if ids <> array[2046, 5839, 99902, 2048, 99901]::bigint[] then
    raise exception 'family of Damage Control I: got %', ids;
  end if;

  -- The columns of one member, and the root's defaults.
  select * into r from public.sde_type_variants(2048) where type_id = 2048;
  if r.name <> 'Damage Control II' or r.meta_level <> 5 or r.meta_group_id <> 2
     or r.meta_group_name <> 'Tech II' or not r.published or r.is_parent or r.group_id <> 60 then
    raise exception 'Damage Control II row wrong: %', r;
  end if;
  select * into r from public.sde_type_variants(2048) where type_id = 2046;
  if r.meta_level <> 0 or r.meta_group_id is not null or r.meta_group_name is not null or not r.is_parent then
    raise exception 'the root reads meta level 0, no tier, is_parent: %', r;
  end if;
  select * into r from public.sde_type_variants(2048) where type_id = 99902;
  if r.published then raise exception 'an unpublished variant must be flagged, got %', r; end if;

  -- A type with no family is a family of one; an unknown id is no family.
  select array_agg(type_id) into ids from public.sde_type_variants(34);
  if ids <> array[34]::bigint[] then raise exception 'Tritanium alone, got %', ids; end if;
  if exists (select 1 from public.sde_type_variants(424242)) then
    raise exception 'an unknown type id must return nothing';
  end if;

  -- Families do not bleed into each other.
  select array_agg(type_id order by type_id) into ids from public.sde_type_variants(3002);
  if ids <> array[3001, 3002]::bigint[] then raise exception 'Shield Extender family, got %', ids; end if;
end $$;

-- Public-read like the other sde_* functions.
do $$
begin
  set local role anon;
  if (select count(*) from public.sde_type_variants(5839)) <> 5 then
    raise exception 'anon must read the family';
  end if;
  reset role;
end $$;

-- The family lookup probes the expression index rather than scanning.
do $$
declare
  line text;
  plan text := '';
begin
  set local enable_seqscan = off;
  for line in execute
    'explain select _key from public.sde_types where (data ->> ''variationParentTypeID'')::bigint = 2046'
  loop
    plan := plan || line || E'\n';
  end loop;
  if plan not like '%sde_types_variation_parent_idx%' then
    raise exception 'expected the variation parent index in the plan, got %', plan;
  end if;
end $$;

rollback;
