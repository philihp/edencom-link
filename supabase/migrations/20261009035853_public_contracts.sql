-- Public contracts: every outstanding public contract in New Eden, plus the
-- ones that closed recently (docs/public-contracts.md). Fed by the
-- public-contracts extract from ESI's unauthenticated
-- /contracts/public/{region_id}/ and /contracts/public/items/{contract_id}/.
--
-- ESI lists only OUTSTANDING public contracts and says nothing about how one
-- ended. So "closed" is inferred: a contract we stored that is missing from a
-- complete snapshot of its region has closed somewhere between the snapshot
-- that last listed it and the one that does not. `closure` reads that gap
-- against the contract's own expiry: past it, the contract most likely
-- expired; before it, somebody accepted it or the issuer withdrew it, and ESI
-- cannot tell those two apart.
--
-- Open rows are never touched while they stay listed. The region's snapshot
-- time in public_contract_region is "last seen" for every open row, the same
-- way the asset extracts stopped stamping unchanged rows (2026-10-05).

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
  -- Set only when the contract closes: the snapshot time of the last listing
  -- that still held it. Null while open; the region's observed_at is then the
  -- last sighting.
  last_seen_at timestamptz,
  -- The snapshot time of the first complete listing without it.
  closed_at timestamptz,
  closure text check (closure in ('expired', 'gone')),
  -- When the item list was pulled, and how ESI answered: 200 with items, or
  -- 204/404 once the contract had already gone. Null means still owed a pull.
  items_fetched_at timestamptz,
  items_status smallint,
  check ((closed_at is null) = (closure is null))
);

-- The sweep's "open here but not listed" scan, once per region per run.
create index public_contract_open_region_idx on public.public_contract (region_id) where closed_at is null;
-- "What closed recently", and the retention sweep.
create index public_contract_closed_at_idx on public.public_contract (closed_at) where closed_at is not null;
-- The item backlog, newest first.
create index public_contract_items_pending_idx
  on public.public_contract (date_issued desc)
  where items_fetched_at is null and closed_at is null;
-- Intel lookups: what a corporation or a pilot has on the market.
create index public_contract_issuer_corporation_id_idx on public.public_contract (issuer_corporation_id);
create index public_contract_issuer_id_idx on public.public_contract (issuer_id);

create table public.public_contract_item (
  contract_id bigint not null references public.public_contract (contract_id) on delete cascade,
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

-- One row per region: the snapshot last reconciled, and when ESI's cache of it
-- expires, so a run asks ESI only about regions with a newer snapshot due.
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

-- Public data that anyone can read in the game client, but gathered here as
-- intel, so it is for signed-in members only: no anon policy.
alter table public.public_contract enable row level security;
alter table public.public_contract_item enable row level security;
alter table public.public_contract_region enable row level security;

create policy "Members read public contracts" on public.public_contract
  for select to authenticated using (true);
create policy "Members read public contract items" on public.public_contract_item
  for select to authenticated using (true);
create policy "Members read public contract regions" on public.public_contract_region
  for select to authenticated using (true);

grant select on public.public_contract, public.public_contract_item, public.public_contract_region to authenticated;
grant all on public.public_contract, public.public_contract_item, public.public_contract_region to service_role;

-- Reconcile one region against a complete listing, in one round trip:
--
--   1. close every open contract in the region that the listing lacks,
--   2. reopen any contract marked closed that the listing holds again (a
--      listing we wrongly accepted as complete must not close it for good),
--   3. answer the listed ids we have never stored, for the caller to insert.
--
-- The caller passes only listings it has checked for completeness
-- (listingCheck in src/jobs/publicContractFields.js). The id list is joined,
-- never scanned with `= any`, so The Forge's ~35k ids cost one hash anti-join
-- rather than a scan per open row.
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
  closed_count integer;
  reopened_count integer;
  new_ids bigint[];
begin
  update public.public_contract c
     set closed_at = p_observed_at,
         last_seen_at = coalesce(p_previous_observed_at, c.first_seen_at),
         closure = case when c.date_expired <= p_observed_at then 'expired' else 'gone' end
   where c.region_id = p_region_id
     and c.closed_at is null
     and not exists (select 1 from unnest(p_contract_ids) as l(id) where l.id = c.contract_id);
  get diagnostics closed_count = row_count;

  update public.public_contract c
     set closed_at = null, last_seen_at = null, closure = null
   where c.closed_at is not null
     and c.contract_id in (select l.id from unnest(p_contract_ids) as l(id));
  get diagnostics reopened_count = row_count;

  select coalesce(array_agg(l.id), '{}')
    into new_ids
    from (select distinct id from unnest(p_contract_ids) as u(id)) as l
   where not exists (select 1 from public.public_contract c where c.contract_id = l.id);

  return jsonb_build_object('closed', closed_count, 'reopened', reopened_count, 'new_ids', to_jsonb(new_ids));
end;
$$;

-- Service role only: every public function is executable by anon and
-- authenticated by default, and this one writes.
revoke execute on function public.public_contract_sweep(bigint, bigint[], timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.public_contract_sweep(bigint, bigint[], timestamptz, timestamptz) to service_role;
