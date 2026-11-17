-- Two of the database's largest Disk IO consumers, rewritten after a Supabase
-- "running out of Disk IO Budget" warning on 2026-11-13. Measured with
-- pg_stat_statements over the 9.5 hours after the 14:10 UTC restart that day:
--
--   1. refresh_asset_location_summary_cache: 171 calls, ~4s each, ~29 GB of
--      block reads and temp IO — every call read the whole of both asset
--      version tables, whatever account it was for.
--   2. the universe-names job's trade-counterparty scan: 272 OFFSET pages over
--      corp_contract_with_status, each re-running the full join, ~13 GB.
--
-- Together that was most of the IO the instance did. See schema.sql for the
-- full comments; the function bodies below are copied from it.
--
-- Written as 20261113234837 and merged after 20261116231117 and
-- 20261116231119, whose comments still name it by that first stamp. It was
-- never applied anywhere under it; the ordering guard refuses a migration
-- stamped before one already on main, so it took a fresh one.

-- Scoped to one account by argument rather than by auth.uid(), and SECURITY
-- DEFINER so the "Audience reads shared assets" policy on
-- character_asset_over_time never enters the plan — that policy ORs a recursive
-- asset_share_covers() call alongside the ownership test, which makes the
-- registration_id index unusable and costs ~2.3s per scan.
--
-- The account's owners are read into two arrays first and the views filtered
-- with `= any(array)`, never `in (select … from registration)`. The views are
-- UNION ALLs over the version table; a constant array is pushed into every
-- branch as an index condition, while a semi-join against a subquery is not,
-- so the IN form read all 599K character and 345K corp asset versions for
-- every account and spilled the joins to disk — the largest single consumer
-- of the database's Disk IO budget, 3.2s and ~9K temp blocks a call
-- (2026-11-13; 20261117013400). force_custom_plan keeps it that way after
-- plpgsql's fifth call: a generic plan cannot see the array's length and
-- goes back to joining every current item rather than probing the few it
-- needs (46ms custom vs 2.2s generic, measured on the 31-character account).
create or replace function public.refresh_asset_location_summary_cache(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path to 'public'
set plan_cache_mode to 'force_custom_plan'
as $$
declare
  v_rows integer;
  v_registration_ids uuid[];
  v_corporation_ids bigint[];
begin
  if p_user_id is null then
    return 0;
  end if;

  -- Serialize this account against itself. The per-character workflow runs an
  -- account's characters across concurrent lanes, so several of them call this
  -- for one user_id at once; two delete-then-insert transactions under READ
  -- COMMITTED collide on the primary key, because neither delete can see the
  -- rows the other has just inserted (20260902040610). Keyed on the account, so
  -- different accounts still rebuild concurrently; the two-argument form
  -- namespaces the key against the table-name locks the *_claim() functions take.
  perform pg_advisory_xact_lock(hashtext('asset_location_summary_cache'), hashtext(p_user_id::text));

  -- The account's characters, and the corporations they are in — exactly what
  -- corp_asset_version's RLS keys off, so the corp rows match what the caller
  -- could read live.
  select coalesce(array_agg(r.id), '{}'),
         coalesce(array_agg(distinct r.corporation_id) filter (where r.corporation_id is not null), '{}')
    into v_registration_ids, v_corporation_ids
    from public.registration r
   where r.user_id = p_user_id;

  -- One transaction: the page must never observe a half-rebuilt account.
  delete from public.asset_location_summary_cache where user_id = p_user_id;

  with recursive
  char_visible as (
    select a.item_id, a.location_id, a.location_type, a.registration_id, a.is_current, a.valid_until
    from public.character_asset_over_time a
    where a.registration_id = any(v_registration_ids)
  ),
  -- One best-known parent per item, so the walk can bridge a container that has
  -- momentarily dropped out of the current snapshot — one handed between the
  -- account's own characters, whose extracts run at different times. Narrowed to
  -- ids that appear as somebody's location, which is all the walk can probe.
  char_parent as (
    select distinct on (item_id) item_id, location_id, location_type
    from char_visible
    where item_id in (select location_id from char_visible where location_id is not null)
    order by item_id, is_current desc, valid_until desc
  ),
  char_walk as (
    select v.item_id as start_item, v.registration_id, v.location_id, v.location_type, 1 as depth
    from char_visible v
    where v.is_current
    union all
    select w.start_item, w.registration_id, p.location_id, p.location_type, w.depth + 1
    from char_walk w
    join char_parent p on p.item_id = w.location_id
    where w.depth < 64
  ),
  char_rows as (
    select 'character'::text as owner_scope,
           w.registration_id::text as owner_id,
           w.location_id,
           -- Aggregated, not grouped: the primary key carries no location_type,
           -- so grouping by it could emit two rows that collide on insert. A
           -- location's type is a property of the location rather than of who
           -- is looking, so a disagreement means one sighting is stale — and
           -- picking deterministically beats failing the extract.
           min(w.location_type) as location_type,
           count(*) as stacks
    from char_walk w
    where w.location_id is not null
      and not exists (select 1 from char_parent o where o.item_id = w.location_id)
    group by w.registration_id, w.location_id
  ),
  -- Same shape over corp assets, scoped to the corporations this account has a
  -- character in.
  corp_visible as (
    select a.item_id, a.location_id, a.location_type, a.corporation_id, a.is_current, a.valid_until
    from public.corp_asset_over_time a
    where a.corporation_id = any(v_corporation_ids)
  ),
  corp_parent as (
    select distinct on (item_id) item_id, location_id, location_type
    from corp_visible
    where item_id in (select location_id from corp_visible where location_id is not null)
    order by item_id, is_current desc, valid_until desc
  ),
  corp_walk as (
    select v.item_id as start_item, v.corporation_id, v.location_id, v.location_type, 1 as depth
    from corp_visible v
    where v.is_current
    union all
    select w.start_item, w.corporation_id, p.location_id, p.location_type, w.depth + 1
    from corp_walk w
    join corp_parent p on p.item_id = w.location_id
    where w.depth < 64
  ),
  corp_rows as (
    select 'corporation'::text as owner_scope,
           w.corporation_id::text as owner_id,
           w.location_id,
           min(w.location_type) as location_type,
           count(*) as stacks
    from corp_walk w
    where w.location_id is not null
      and not exists (select 1 from corp_parent o where o.item_id = w.location_id)
    group by w.corporation_id, w.location_id
  )
  insert into public.asset_location_summary_cache
    (user_id, owner_scope, owner_id, location_id, location_type, stacks)
  select p_user_id, owner_scope, owner_id, location_id, location_type, stacks
  from (select * from char_rows union all select * from corp_rows) r;

  get diagnostics v_rows = row_count;
  return v_rows;
end
$$;


-- ── Trade counterparties, for the universe-names job ──────────────────────
-- Every party id (issuer, issuer's corporation, acceptor) of a finished item
-- exchange or auction accepted since p_since, across both contract views,
-- deduplicated here and answered as one array. resolveTradeCounterpartyNames
-- (src/resolveNames.js) names them so the market page can say who a trade was
-- with. It used to page each view 1,000 rows at a time with OFFSET: 271K
-- matching corp rows were 272 requests, each repeating the contract × status
-- join from the top — ~343s of database time and ~13 GB of disk and temp IO
-- per run, to find ~9.5K distinct ids. One pass is ~1.2s (2026-11-13,
-- 20261117013400). An array rather than a set so PostgREST's 1,000-row
-- max_rows cap never truncates it. Read-only, but service role only like the
-- job that calls it.
create or replace function public.trade_contract_party_ids(p_since timestamptz)
returns bigint[]
language sql
stable
set search_path = public
as $$
  select coalesce(array_agg(d.id), '{}')
  from (
    select distinct t.id
    from (
      select unnest(array[c.issuer_id, c.issuer_corporation_id, c.acceptor_id]) as id
      from public.character_contract_with_status c
      where c.status = 'finished'
        and c.type in ('item_exchange', 'auction')
        and c.date_accepted >= p_since
      union all
      select unnest(array[c.issuer_id, c.issuer_corporation_id, c.acceptor_id])
      from public.corp_contract_with_status c
      where c.status = 'finished'
        and c.type in ('item_exchange', 'auction')
        and c.date_accepted >= p_since
    ) t
    where t.id > 0
  ) d
$$;

revoke execute on function public.trade_contract_party_ids(timestamptz) from public, anon, authenticated;
grant execute on function public.trade_contract_party_ids(timestamptz) to service_role;
