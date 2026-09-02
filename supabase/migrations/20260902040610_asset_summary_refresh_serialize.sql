-- Two accounts' characters cannot rebuild the same rollup at once.
--
-- ── The failure ───────────────────────────────────────────────────────────
--   duplicate key value violates unique constraint
--   "asset_location_summary_cache_pkey"
--
-- 28 character-assets runs and 2 corp-assets runs since 20260901031842 landed.
-- Every failing account is a multi-character one — 18, 15, 12, 9 and 7
-- characters — and no single-character account failed once. That is the whole
-- diagnosis: the per-character workflow runs an account's characters across
-- concurrent lanes, so N characters of one account each call
-- refresh_asset_location_summary_cache(<the same user_id>) at the same moment.
--
-- The function deletes the account's rows and reinserts them. Two of those
-- running together, under READ COMMITTED:
--
--   A: delete (locks A's snapshot of the rows) ; insert fresh rows
--   B: delete — B's snapshot cannot see rows A has only just inserted, so they
--      survive — ; insert the same keys again  ->  duplicate key
--
-- This is the same race 20260831043706 already guards in the *_claim()
-- functions, and the guard was simply not carried over to this one.
--
-- ── The lock ──────────────────────────────────────────────────────────────
-- Transaction-scoped and keyed on the account, not the table: two different
-- accounts still rebuild concurrently, and only an account racing itself waits.
-- The two-argument form namespaces the key space, so a user-uuid hash can never
-- collide with the table-name hashes the claim functions take.
--
-- ── The second defect, latent ─────────────────────────────────────────────
-- The rollup grouped by (owner, location_id, location_type) while the primary
-- key is (user_id, owner_scope, owner_id, location_id) — no location_type. One
-- location seen under two location_type values for the same owner therefore
-- produces two rows that collide on insert, with no concurrency involved at
-- all. No account has such a pair today (checked against production), so this
-- is not what has been failing; it is a hole the type of the key leaves open.
-- Grouping now matches the primary key exactly and the type is aggregated,
-- which makes a colliding pair unconstructible rather than merely absent.
-- min() over a set that should be a single value: a location's type is a
-- property of the location, not of who is looking at it, so a disagreement
-- means one of the two sightings is stale — and picking deterministically
-- beats failing the whole extract.

create or replace function public.refresh_asset_location_summary_cache(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_rows integer;
begin
  if p_user_id is null then
    return 0;
  end if;

  -- Serialize this account against itself; other accounts are unaffected.
  perform pg_advisory_xact_lock(hashtext('asset_location_summary_cache'), hashtext(p_user_id::text));

  -- One transaction: the page must never observe a half-rebuilt account.
  delete from public.asset_location_summary_cache where user_id = p_user_id;

  with recursive
  mine as (
    select id, corporation_id from public.registration where user_id = p_user_id
  ),
  char_visible as (
    select a.item_id, a.location_id, a.location_type, a.registration_id, a.is_current, a.valid_until
    from public.character_asset_over_time a
    where a.registration_id in (select id from mine)
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
           min(w.location_type) as location_type,
           count(*) as stacks
    from char_walk w
    where w.location_id is not null
      and not exists (select 1 from char_parent o where o.item_id = w.location_id)
    group by w.registration_id, w.location_id
  ),
  -- Same shape over corp assets, scoped to the corporations this account has a
  -- character in — exactly what corp_asset_over_time's RLS keys off, so the row
  -- set matches what the caller could read live.
  corp_visible as (
    select a.item_id, a.location_id, a.location_type, a.corporation_id, a.is_current, a.valid_until
    from public.corp_asset_over_time a
    where a.corporation_id in (select corporation_id from mine where corporation_id is not null)
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

-- A corp extract fans out to every account with a character in that corp, so it
-- takes several of the per-account locks inside one transaction. Two such
-- transactions with overlapping members would deadlock if they took them in
-- different orders, so the loop is ordered: every caller acquires the same
-- accounts in the same sequence.
create or replace function public.refresh_asset_location_summary_cache_for_corporation(p_corporation_id bigint)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_user  uuid;
  v_users integer := 0;
begin
  if p_corporation_id is null then
    return 0;
  end if;

  for v_user in
    select distinct user_id from public.registration
    where corporation_id = p_corporation_id and user_id is not null
    order by user_id
  loop
    perform public.refresh_asset_location_summary_cache(v_user);
    v_users := v_users + 1;
  end loop;

  return v_users;
end
$$;
