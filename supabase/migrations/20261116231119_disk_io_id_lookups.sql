-- The next Disk IO consumers after 20261113234837, measured with
-- pg_stat_statements over the 27.7 hours after the 2026-11-15 restart. Each is
-- a lookup that read far more than it answered:
--
--   1. sde_published_type by group_id (the market-depth job's gas types,
--      hourly): no index on the type's group, so every call detoasted the jsonb
--      of all 54K sde_types rows to keep 55 — 29 calls, 6.7 s and 21K blocks
--      read each. An expression index on the group id, the same shape as
--      sde_types_variation_parent_idx, answers it from the 55 rows. The same
--      read through getSdeTypesInGroups (src/sdeTypes.ts) runs on the anon
--      client, whose 3 s statement_timeout it could not finish inside.
--
--   2. Five id harvests in the extract jobs, each paging a table through
--      PostgREST 1,000 rows at a time with OFFSET. Every page re-reads (and,
--      when the order is not an index's, re-sorts) everything before it, so a
--      run costs O(rows²): the universe-structures job's corp_contract pass
--      alone was 492 pages, 2.05M blocks read and 1.68M temp blocks for one
--      daily run. Each now asks one function for the distinct ids, the shape
--      trade_contract_party_ids() has:
--
--        structure_location_candidate_ids   universe-structures, ten sources
--        industry_job_structure_system_ids  industry-systems, hourly
--        corp_journal_party_ids             universe-names, 1,083 pages, 1.67M blocks
--        corp_industry_job_installer_ids    universe-names
--        asset_root_place_ids               universe-names, stations and systems
--
--      Each returns one bigint[] rather than a set, so PostgREST's max-rows cap
--      never truncates it, and each is service-role only: they read every
--      account's rows, which only the jobs may.
--
-- See schema.sql for the full comments; the bodies below are copied from it.

-- ── 1. sde_types by group ───────────────────────────────────────────────────
create index if not exists sde_types_group_idx
  on public.sde_types (((data ->> 'groupID')::bigint));

-- An expression index has no statistics until the table is analyzed, and the
-- planner needs them to prefer it over the sequential scan it costs as cheap
-- (it does not price detoasting).
analyze public.sde_types;

-- ── 2. Id harvests ──────────────────────────────────────────────────────────

create or replace function public.structure_location_candidate_ids(p_floor bigint)
returns bigint[]
language sql
stable
set search_path = public
as $$
  select coalesce(array_agg(d.id order by d.id), '{}')
  from (
    select distinct s.id
    from (
      select l.location_id as id
        from public.character_asset_location l
        join public.character_asset_version v on v.id = l.asset_id
       where v.is_current and v.location_id is null
      union all
      select l.location_id
        from public.corp_asset_location l
        join public.corp_asset_version v on v.id = l.asset_id
       where v.is_current and v.location_id is null
      union all
      select v.location_id
        from public.corp_asset_version v
       where v.is_current
         and exists (
           select 1 from public.corp_asset_version p
            where p.item_id = v.location_id and p.is_current
         )
      union all
      select o.location_id from public.character_order_over_time o where o.is_current
      union all
      select unnest(array[j.facility_id, j.station_id, j.blueprint_location_id, j.output_location_id])
        from public.character_industry_job_over_time j
       where j.is_current
      union all
      select unnest(array[j.facility_id, j.station_id, j.blueprint_location_id, j.output_location_id])
        from public.corp_industry_job_over_time j
       where j.is_current
      union all
      select unnest(array[c.start_location_id, c.end_location_id]) from public.character_contract c
      union all
      select unnest(array[c.start_location_id, c.end_location_id]) from public.corp_contract c
      union all
      select t.location_id from public.character_wallet_transaction t
      union all
      select t.location_id from public.corp_wallet_transaction t
      union all
      select k.location_id
        from public.character_clone_over_time k
       where k.is_current and k.location_type = 'structure'
    ) s
    where s.id >= p_floor
  ) d
  where not exists (
    select 1 from public.character_asset_version i
     where i.item_id = d.id and i.is_current
  )
$$;

create or replace function public.industry_job_structure_system_ids(p_floor bigint)
returns bigint[]
language sql
stable
set search_path = public
as $$
  select coalesce(array_agg(distinct s.system_id order by s.system_id), '{}')
  from public.universe_structure s
  where s.system_id is not null
    and s.structure_id >= p_floor
    and s.structure_id in (
      select coalesce(j.station_id, j.facility_id)
        from public.character_industry_job_over_time j
       where j.is_current
      union all
      select coalesce(j.station_id, j.facility_id)
        from public.corp_industry_job_over_time j
       where j.is_current
    )
$$;

create or replace function public.corp_journal_party_ids(p_since timestamptz)
returns bigint[]
language sql
stable
set search_path = public
as $$
  select coalesce(array_agg(d.id order by d.id), '{}')
  from (
    select distinct t.id
    from (
      select unnest(array[j.first_party_id, j.second_party_id]) as id
        from public.corp_wallet_journal j
       where j.date >= p_since
    ) t
    where t.id > 0
  ) d
$$;

create or replace function public.corp_industry_job_installer_ids()
returns bigint[]
language sql
stable
set search_path = public
as $$
  select coalesce(array_agg(distinct j.installer_id order by j.installer_id), '{}')
  from public.corp_industry_job_over_time j
  where j.is_current and j.installer_id > 0
$$;

create or replace function public.asset_root_place_ids(p_location_type text, p_include_corp boolean default false)
returns bigint[]
language sql
stable
set search_path = public
as $$
  select coalesce(array_agg(distinct d.id order by d.id), '{}')
  from (
    select l.location_id as id
      from public.character_asset_location l
      join public.character_asset_version v on v.id = l.asset_id
     where v.is_current and v.location_id is null and l.location_type = p_location_type
    union all
    select l.location_id
      from public.corp_asset_location l
      join public.corp_asset_version v on v.id = l.asset_id
     where p_include_corp and v.is_current and v.location_id is null and l.location_type = p_location_type
  ) d
  where d.id > 0
$$;

revoke execute on function public.structure_location_candidate_ids(bigint) from public, anon, authenticated;
revoke execute on function public.industry_job_structure_system_ids(bigint) from public, anon, authenticated;
revoke execute on function public.corp_journal_party_ids(timestamptz) from public, anon, authenticated;
revoke execute on function public.corp_industry_job_installer_ids() from public, anon, authenticated;
revoke execute on function public.asset_root_place_ids(text, boolean) from public, anon, authenticated;
grant execute on function public.structure_location_candidate_ids(bigint) to service_role;
grant execute on function public.industry_job_structure_system_ids(bigint) to service_role;
grant execute on function public.corp_journal_party_ids(timestamptz) to service_role;
grant execute on function public.corp_industry_job_installer_ids() to service_role;
grant execute on function public.asset_root_place_ids(text, boolean) to service_role;
