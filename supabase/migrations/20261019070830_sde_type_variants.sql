-- A type's variation family, each member with its meta level — what the MCP
-- module_variants tool answers "what are the upgrades for this module" from.
--
-- CCP's SDE ties a family together through one field: every variant of a
-- module carries variationParentTypeID, naming the family's root (Damage
-- Control II, IFFA Compact Damage Control and the faction and deadspace damage
-- controls all name Damage Control I, 2046); the root carries none. Meta level
-- is a dogma attribute (633, metaLevel) in typeDogma, and the tier name
-- (Tech II, Faction, Deadspace…) is in metaGroups.
--
-- Reading the family needs an index: the field is inside sde_types' jsonb, and
-- a scan of that ~220 MB table runs past anon's 3 s statement_timeout (seen
-- 2026-10-19). One btree on the cast expression makes it one probe.

-- Both tables arrive with the first ingest; a fresh reset runs before it, and
-- this function's body is checked against them at creation — mint them first,
-- as 20260902092205_sde_system_jump.sql does for map_stargates.
select public.ensure_sde_mirror_table('type_dogma');
select public.ensure_sde_mirror_table('meta_groups');

create index if not exists sde_types_variation_parent_idx
  on public.sde_types (((data ->> 'variationParentTypeID')::bigint));

-- The family of p_type_id: its root plus every type naming that root as its
-- parent, whichever member is asked about. Unpublished members are returned
-- and flagged rather than dropped, so a caller can say why a variant it knows
-- of cannot be bought. A type with no family is a family of one; an unknown
-- id returns nothing. Ordered by meta level, then tier, then name.
create or replace function public.sde_type_variants(p_type_id bigint)
returns table (
  type_id bigint,
  name text,
  group_id bigint,
  meta_group_id bigint,
  meta_group_name text,
  meta_level int,
  published boolean,
  is_parent boolean
)
language sql
stable
set search_path = ''
as $$
  with parent as (
    select coalesce((t.data ->> 'variationParentTypeID')::bigint, t._key) as id
    from public.sde_types t
    where t._key = p_type_id
  ),
  member as (
    select p.id as type_id from parent p
    union
    select t._key
    from public.sde_types t
    join parent p on (t.data ->> 'variationParentTypeID')::bigint = p.id
  )
  select
    t._key,
    t.data -> 'name' ->> 'en',
    (t.data ->> 'groupID')::bigint,
    (t.data ->> 'metaGroupID')::bigint,
    mg.data -> 'name' ->> 'en',
    -- metaLevel's default is 0, and a plain Tech I type often omits it.
    coalesce(ml.meta_level, 0),
    coalesce((t.data ->> 'published')::boolean, false),
    t._key = p.id
  from member m
  join public.sde_types t on t._key = m.type_id
  cross join parent p
  left join public.sde_meta_groups mg on mg._key = (t.data ->> 'metaGroupID')::bigint
  left join lateral (
    select round((a ->> 'value')::numeric)::int as meta_level
    from public.sde_type_dogma d
    cross join lateral jsonb_array_elements(d.data -> 'dogmaAttributes') a
    where d._key = t._key
      and (a ->> 'attributeID')::int = 633
    limit 1
  ) ml on true
  where coalesce(trim(t.data -> 'name' ->> 'en'), '') <> ''
  order by coalesce(ml.meta_level, 0), (t.data ->> 'metaGroupID')::bigint nulls first, t.data -> 'name' ->> 'en', t._key
$$;

-- Public-read like every sde_* object: invoker rights over tables anon reads.
grant execute on function public.sde_type_variants(bigint) to anon, authenticated, service_role;
