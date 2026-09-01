-- Stop recomputing the whole-hangar container walk on every /asset render.
--
-- ── What it costs today ───────────────────────────────────────────────────
-- character_asset_location_summary() averages 5,290 ms across 75 production
-- calls (pg_stat_statements), max 7,811 ms. corp_asset_location_summary() adds
-- ~320 ms, and assetExtractStamp — the heartbeat read that only exists to key
-- the Next.js data cache — another ~669 ms. About 6.3 seconds of database time
-- to produce ~470 rows from data that changes when a 6-hourly extract runs.
--
-- Two things make the walk expensive, and the rollup removes both:
--
--   1. It is recomputed per request. 20260807010000 already narrowed the
--      parent_of CTE by 28x and said in its own header that the real fix is to
--      stop recomputing it at all. This is that fix.
--   2. It runs under RLS, and character_asset_over_time carries a second
--      permissive policy — "Audience reads shared assets", which is
--      `is_current AND asset_share_covers(item_id, registration_id)`. OR'd with
--      the cheap ownership policy it makes the registration_id index unusable,
--      so the planner scans the whole table and calls asset_share_covers() — a
--      16-deep recursive walk of its own — once per row the caller does not
--      own. Measured: a bare `select count(*) ... where is_current` costs
--      2,298 ms for a 9-character account, of which the bitmap index scan is
--      8.4 ms and the rest is ~100k invocations of that function.
--
-- The refresh below runs SECURITY DEFINER and filters on registration/corp
-- ownership directly, so it never evaluates that policy at all.
--
-- ── On dropping shared assets from this page ──────────────────────────────
-- Because the walk ran under RLS, the summary could in principle include assets
-- someone else shares with the caller. The rollup is computed per account and
-- deliberately does not.
--
-- That matches what the page actually models rather than narrowing it.
-- fetchOwners() (src/app/owners.ts) builds the owner picker from the caller's
-- own registrations and their corporations, and nothing else — so a row
-- bucketed under a *foreign* registration_id arrives keyed to an owner the
-- picker cannot name. Shared assets are reached through /ship/[itemId] and the
-- signed share links, not through this index. The share policy showing up in
-- this particular query was incidental to RLS, not a feature of the page.
--
-- It is also moot in fact today: every row in character_asset_share is a link
-- share (a secret with empty corporation_ids/alliance_ids), and
-- share_audience_matches() returns false for those by design — RLS never sees a
-- URL token, the app layer verifies it (docs/sharing-layer). So the policy
-- currently grants no one any row, and this changes no visible behaviour. If
-- corp- or alliance-audience asset shares are ever wanted *on this page*, the
-- rollup needs a second dimension and this comment is the place that says so.

create table public.asset_location_summary_cache (
  user_id       uuid   not null references auth.users(id) on delete cascade,
  -- Which side of the union a row came from. The page keys `counts` by
  -- owner_id alone (a registration uuid, or a corporation id as text, exactly
  -- as fetchOwners() labels them), but the two id spaces are different types
  -- flattened to text, so the scope is what keeps the primary key honest.
  owner_scope   text   not null check (owner_scope in ('character', 'corporation')),
  owner_id      text   not null,
  location_id   bigint not null,
  location_type text,
  stacks        bigint not null,
  refreshed_at  timestamptz not null default now(),
  primary key (user_id, owner_scope, owner_id, location_id)
);

alter table public.asset_location_summary_cache enable row level security;

-- Read-only to its owner. Nothing but the refresh function writes here, and
-- that runs as the service role from the extract jobs.
create policy "Users read own asset summary cache"
  on public.asset_location_summary_cache
  for select
  using (user_id = (select auth.uid()));

grant select on public.asset_location_summary_cache to authenticated;
grant select, insert, update, delete on public.asset_location_summary_cache to service_role;

-- ── The rollup ────────────────────────────────────────────────────────────
-- The same walk the two summary functions do, with three differences: it is
-- scoped to one account by argument rather than by auth.uid(), it runs
-- SECURITY DEFINER so the share policy above never enters the plan, and it
-- unions the character and corporation halves into the one shape the page
-- consumes.
--
-- Recomputed wholesale per account rather than incrementally. The walk is
-- ~400 ms of honest work for the largest account here once the RLS tax is
-- gone, it runs a handful of times per extract cycle instead of once per page
-- view, and an incremental version would have to reason about a container
-- moving between characters — which is exactly the case that has already cost
-- this codebase one production bug (20260831043706).
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

  -- One transaction: the page must never observe a half-rebuilt account.
  delete from public.asset_location_summary_cache where user_id = p_user_id;

  with recursive
  mine as (
    select id, corporation_id from public.registration where user_id = p_user_id
  ),
  -- ── character half ──────────────────────────────────────────────────────
  char_visible as (
    select a.item_id, a.location_id, a.location_type, a.registration_id, a.is_current, a.valid_until
    from public.character_asset_over_time a
    where a.registration_id in (select id from mine)
  ),
  -- One best-known parent per item, so the walk can bridge a container that has
  -- momentarily dropped out of the current snapshot — one handed between the
  -- account's own characters, whose extracts run at different times — instead of
  -- stranding its contents on a bare item id. Narrowed to ids that actually
  -- appear as somebody's location, which is all the walk can ever probe
  -- (20260807010000).
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
           w.location_type,
           count(*) as stacks
    from char_walk w
    where w.location_id is not null
      and not exists (select 1 from char_parent o where o.item_id = w.location_id)
    group by w.registration_id, w.location_id, w.location_type
  ),
  -- ── corporation half ────────────────────────────────────────────────────
  -- Same shape over corp_asset_over_time, scoped to the corporations this
  -- account has a character in — which is exactly what that table's RLS keys
  -- off, so the row set matches what the caller could read live.
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
           w.location_type,
           count(*) as stacks
    from corp_walk w
    where w.location_id is not null
      and not exists (select 1 from corp_parent o where o.item_id = w.location_id)
    group by w.corporation_id, w.location_id, w.location_type
  )
  insert into public.asset_location_summary_cache
    (user_id, owner_scope, owner_id, location_id, location_type, stacks)
  select p_user_id, owner_scope, owner_id, location_id, location_type, stacks
  from (select * from char_rows union all select * from corp_rows) r;

  get diagnostics v_rows = row_count;
  return v_rows;
end
$$;

-- A corp extract moves the corporation half for every account with a character
-- in that corp, not just the one whose token ran the job.
--
-- That is a fan-out, so it is worth sizing: the widest corporation here has 15
-- accounts in it, and a rebuild is ~400ms for the largest of them and far less
-- for the rest — a few seconds, inside one daily step's budget. It is a whole
-- rebuild per account rather than a corp-only patch because the two halves
-- share a table and a primary key, and splitting the delete by owner_scope to
-- save a second-worth of walking would buy a way for the halves to disagree.
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
    select distinct user_id from public.registration where corporation_id = p_corporation_id and user_id is not null
  loop
    perform public.refresh_asset_location_summary_cache(v_user);
    v_users := v_users + 1;
  end loop;

  return v_users;
end
$$;

-- SECURITY DEFINER, so these must not be callable by anyone but the jobs.
-- schema.sql still hands new functions EXECUTE to anon/authenticated by default
-- (`alter default privileges ... grant all on functions`), and Postgres grants
-- EXECUTE to PUBLIC on top of that, so each has to claw it back the way
-- ensure_sde_mirror_table() does.
revoke execute on function public.refresh_asset_location_summary_cache(uuid) from public, anon, authenticated;
revoke execute on function public.refresh_asset_location_summary_cache_for_corporation(bigint)
  from public, anon, authenticated;

grant execute on function public.refresh_asset_location_summary_cache(uuid) to service_role;
grant execute on function public.refresh_asset_location_summary_cache_for_corporation(bigint) to service_role;

-- ── Backfill ──────────────────────────────────────────────────────────────
-- Without this, every existing account reads an empty cache — which is
-- indistinguishable from "you own nothing" — until its next extract, up to six
-- hours of a blank asset page. The page has no live fallback by design (a
-- fallback that fires on an empty result would fire for every account that
-- genuinely owns nothing), so the table has to be correct the moment it exists.
do $$
declare r record;
begin
  for r in select distinct user_id from public.registration where user_id is not null
  loop
    perform public.refresh_asset_location_summary_cache(r.user_id);
  end loop;
end $$;
