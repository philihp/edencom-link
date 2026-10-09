-- Public contracts: every public contract New Eden has listed since this
-- extract started, open or closed (docs/public-contracts.md). Fed by the
-- public-contracts extract from ESI's unauthenticated
-- /contracts/public/{region_id}/ and /contracts/public/items/{contract_id}/.
--
-- A contract's facts are frozen once it is issued: EVE has no way to edit a
-- contract's price, items or route. Only its status moves. So the facts live
-- in public_contract, written once, and the status lives in
-- public_contract_status_over_time, an SCD-2 history. Nothing here is ever
-- deleted: the service role is granted no DELETE on these tables, and their
-- foreign keys do not cascade.
--
-- ESI lists only OUTSTANDING public contracts and says nothing about how one
-- ended. So a closure is inferred: a contract missing from a complete snapshot
-- of its region closed somewhere between the snapshot that last listed it and
-- the one that does not. The new status reads that gap against the contract's
-- own expiry: past it, the contract most likely expired; before it, somebody
-- accepted it or the issuer withdrew it, and ESI cannot tell those two apart.

-- ── public_contract: the facts, written once ───────────────────────────────
create table public.public_contract (
  contract_id bigint primary key,
  region_id bigint not null,
  -- ESI enum, kept as text: unknown/item_exchange/auction/courier/loan.
  type text not null,
  issuer_id bigint not null,
  issuer_corporation_id bigint not null,
  for_corporation boolean not null default false,
  start_location_id bigint,
  end_location_id bigint,
  title text,
  -- Null where the contract type has no such field (a courier has no price),
  -- never 0: "not applicable" and "zero ISK" are different facts.
  price numeric(20, 2),
  reward numeric(20, 2),
  collateral numeric(20, 2),
  buyout numeric(20, 2),
  volume double precision,
  days_to_complete integer,
  date_issued timestamptz not null,
  date_expired timestamptz not null,
  -- The snapshot time (ESI Last-Modified) of the first listing that held it.
  first_seen_at timestamptz not null,
  -- The extract's own bookkeeping, set once: when the item list was pulled,
  -- and how ESI answered (200 with items, or 204/404 once the contract had
  -- already gone). Null means still owed a pull.
  items_fetched_at timestamptz,
  items_status smallint
);

create index public_contract_region_id_idx on public.public_contract (region_id);
-- The item backlog, newest first (public_contract_items_owed()).
create index public_contract_items_pending_idx
  on public.public_contract (date_issued desc)
  where items_fetched_at is null and type in ('item_exchange', 'auction');
-- Intel lookups: what a corporation or a pilot has put up.
create index public_contract_issuer_corporation_id_idx on public.public_contract (issuer_corporation_id);
create index public_contract_issuer_id_idx on public.public_contract (issuer_id);

-- ── public_contract_status_over_time: the status, as SCD-2 ─────────────────
-- One row per status a contract has held: 'outstanding' while listed, then
-- 'expired' or 'gone' once missing from a complete listing, and 'outstanding'
-- again if a later listing holds it after all.
--
-- valid_from is the snapshot time of the first listing that showed the
-- status. On a superseded row, valid_until is the snapshot time of the LAST
-- listing that confirmed it, so the gap between a row's valid_until and the
-- next row's valid_from is the window in which the change happened. On the
-- current row valid_until is its debut and means nothing: a status is never
-- rewritten while it holds (the region's observed_at is the last sighting),
-- the way the asset extracts stopped touching unchanged rows (2026-10-05).
create table public.public_contract_status_over_time (
  id bigint generated always as identity primary key,
  contract_id bigint not null references public.public_contract (contract_id),
  -- A frozen copy of public_contract.region_id. The sweep asks "what is
  -- outstanding in this region" once per region per run, and answering it
  -- from this table alone keeps that a single partial-index scan.
  region_id bigint not null,
  status text not null check (status in ('outstanding', 'expired', 'gone')),
  valid_from timestamptz not null,
  valid_until timestamptz not null,
  is_current boolean not null default true
);

-- One current status per contract.
create unique index public_contract_status_current_idx
  on public.public_contract_status_over_time (contract_id) where is_current;
-- A contract's history, and the sweep's "has it ever had a status" probe.
create index public_contract_status_history_idx
  on public.public_contract_status_over_time (contract_id, valid_from);
-- The sweep's "outstanding here but not listed" scan.
create index public_contract_status_outstanding_idx
  on public.public_contract_status_over_time (region_id) where is_current and status = 'outstanding';
-- "What closed recently".
create index public_contract_status_closed_idx
  on public.public_contract_status_over_time (valid_from) where is_current and status <> 'outstanding';

create view public.public_contract_status with (security_invoker = on) as
  select id, contract_id, region_id, status, valid_from, valid_until, is_current
  from public.public_contract_status_over_time
  where is_current;

-- ── public_contract_item ───────────────────────────────────────────────────
create table public.public_contract_item (
  contract_id bigint not null references public.public_contract (contract_id),
  record_id bigint not null,
  type_id bigint not null,
  quantity bigint not null,
  -- False on an item the issuer asks FOR rather than offers.
  is_included boolean not null,
  is_blueprint_copy boolean,
  item_id bigint,
  material_efficiency integer,
  time_efficiency integer,
  -- Runs left on a copy; -1 on an original.
  runs integer,
  primary key (contract_id, record_id)
);
create index public_contract_item_type_id_idx on public.public_contract_item (type_id);

-- ── public_contract_region: the extract's state per region ─────────────────
-- The snapshot last reconciled, and when ESI's cache of it expires, so a run
-- asks ESI only about regions with a newer snapshot due.
create table public.public_contract_region (
  region_id bigint primary key,
  -- ESI Last-Modified of the last snapshot reconciled.
  observed_at timestamptz,
  -- ESI Expires of that snapshot. The region is not asked again before it.
  expires_at timestamptz,
  open_contracts integer not null default 0,
  -- The last listing ended on a full page, so ESI may have cut off its newest
  -- contracts (The Forge is served as exactly 35 full pages). Closures stay
  -- right; the newest contracts there are just not stored yet.
  capped boolean not null default false,
  -- Set while a listing has shrunk implausibly (see src/jobs/publicContractFields.js,
  -- shrinkVerdict); cleared once a listing is accepted.
  suspect_since timestamptz,
  checked_at timestamptz not null default now()
);

-- ── Access ─────────────────────────────────────────────────────────────────
-- Public data that anyone can read in the game client, but gathered here as
-- intel, so it is for signed-in members only: no anon policy. The extract
-- writes with the service role, which may insert and update but never delete.
alter table public.public_contract enable row level security;
alter table public.public_contract_status_over_time enable row level security;
alter table public.public_contract_item enable row level security;
alter table public.public_contract_region enable row level security;

create policy "Members read public contracts" on public.public_contract
  for select to authenticated using (true);
create policy "Members read public contract statuses" on public.public_contract_status_over_time
  for select to authenticated using (true);
create policy "Members read public contract items" on public.public_contract_item
  for select to authenticated using (true);
create policy "Members read public contract regions" on public.public_contract_region
  for select to authenticated using (true);

grant select on public.public_contract, public.public_contract_status_over_time, public.public_contract_status,
  public.public_contract_item, public.public_contract_region to authenticated;
grant select, insert, update on public.public_contract, public.public_contract_status_over_time,
  public.public_contract_item, public.public_contract_region to service_role;
grant select on public.public_contract_status to service_role;

-- ── public_contract_sweep() ────────────────────────────────────────────────
-- Reconcile one region's statuses against a complete listing, in one round
-- trip:
--
--   1. every outstanding contract of the region the listing lacks becomes
--      'expired' or 'gone',
--   2. every listed contract whose current status is closed becomes
--      'outstanding' again (a listing we wrongly accepted as complete must not
--      close it for good),
--   3. the listed ids with no status at all come back as new, for the caller
--      to store and then open with public_contract_open().
--
-- Each change closes the current row (valid_until: the previous snapshot,
-- the last that confirmed it) and opens a new one (valid_from: this snapshot).
-- The caller passes only listings it has checked for completeness
-- (listingCheck in src/jobs/publicContractFields.js). The id list is joined,
-- never scanned with `= any`, so The Forge's ~35k ids cost one hash anti-join
-- rather than a scan per outstanding row.
create or replace function public.public_contract_sweep(
  p_region_id bigint,
  p_contract_ids bigint[],
  p_observed_at timestamptz,
  p_previous_observed_at timestamptz
)
returns jsonb
language plpgsql
volatile
set search_path = public
as $$
declare
  closing bigint[];
  reopening bigint[];
  new_ids bigint[];
begin
  with superseded as (
    update public.public_contract_status_over_time s
       set is_current = false,
           valid_until = coalesce(p_previous_observed_at, s.valid_from)
     where s.region_id = p_region_id
       and s.is_current
       and s.status = 'outstanding'
       and not exists (select 1 from unnest(p_contract_ids) as l(id) where l.id = s.contract_id)
    returning s.contract_id
  )
  select coalesce(array_agg(contract_id), '{}') into closing from superseded;

  insert into public.public_contract_status_over_time (contract_id, region_id, status, valid_from, valid_until)
  select c.contract_id, p_region_id,
         case when c.date_expired <= p_observed_at then 'expired' else 'gone' end,
         p_observed_at, p_observed_at
    from public.public_contract c
   where c.contract_id = any (closing);

  with superseded as (
    update public.public_contract_status_over_time s
       set is_current = false,
           valid_until = coalesce(p_previous_observed_at, s.valid_from)
     where s.is_current
       and s.status <> 'outstanding'
       and s.contract_id in (select l.id from unnest(p_contract_ids) as l(id))
    returning s.contract_id
  )
  select coalesce(array_agg(contract_id), '{}') into reopening from superseded;

  insert into public.public_contract_status_over_time (contract_id, region_id, status, valid_from, valid_until)
  select r.id, p_region_id, 'outstanding', p_observed_at, p_observed_at
    from unnest(reopening) as r(id);

  select coalesce(array_agg(l.id), '{}')
    into new_ids
    from (select distinct id from unnest(p_contract_ids) as u(id)) as l
   where not exists (select 1 from public.public_contract_status_over_time s where s.contract_id = l.id);

  return jsonb_build_object(
    'closed', cardinality(closing),
    'reopened', cardinality(reopening),
    'new_ids', to_jsonb(new_ids)
  );
end;
$$;

-- ── public_contract_open() ─────────────────────────────────────────────────
-- Give each stored contract that has no status yet its first one,
-- 'outstanding' from this snapshot. The caller stores the facts of the new ids
-- public_contract_sweep() answered, then calls this. Idempotent: a contract
-- that already has a status is skipped, so a run that died between the two
-- calls is finished by the next one (the sweep answers the same ids as new).
create or replace function public.public_contract_open(
  p_region_id bigint,
  p_contract_ids bigint[],
  p_observed_at timestamptz
)
returns integer
language plpgsql
volatile
set search_path = public
as $$
declare
  opened integer;
begin
  insert into public.public_contract_status_over_time (contract_id, region_id, status, valid_from, valid_until)
  select c.contract_id, p_region_id, 'outstanding', p_observed_at, p_observed_at
    from public.public_contract c
   where c.contract_id in (select distinct l.id from unnest(p_contract_ids) as l(id))
     and not exists (select 1 from public.public_contract_status_over_time s where s.contract_id = c.contract_id);
  get diagnostics opened = row_count;
  return opened;
end;
$$;

-- ── public_contract_items_owed() ───────────────────────────────────────────
-- The newest outstanding item exchanges and auctions whose items have not
-- been pulled yet. A courier is never owed: ESI answers its items with a 400.
create or replace function public.public_contract_items_owed(p_limit integer)
returns setof bigint
language sql
stable
set search_path = public
as $$
  select c.contract_id
    from public.public_contract c
    join public.public_contract_status_over_time s
      on s.contract_id = c.contract_id and s.is_current and s.status = 'outstanding'
   where c.items_fetched_at is null
     and c.type in ('item_exchange', 'auction')
   order by c.date_issued desc
   limit p_limit;
$$;

-- Service role only: every public function is executable by anon and
-- authenticated by default, and these write or serve only the extract.
revoke execute on function public.public_contract_sweep(bigint, bigint[], timestamptz, timestamptz) from public, anon, authenticated;
revoke execute on function public.public_contract_open(bigint, bigint[], timestamptz) from public, anon, authenticated;
revoke execute on function public.public_contract_items_owed(integer) from public, anon, authenticated;
grant execute on function public.public_contract_sweep(bigint, bigint[], timestamptz, timestamptz) to service_role;
grant execute on function public.public_contract_open(bigint, bigint[], timestamptz) to service_role;
grant execute on function public.public_contract_items_owed(integer) to service_role;
