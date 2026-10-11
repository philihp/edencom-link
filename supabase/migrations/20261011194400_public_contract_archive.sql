-- Public contracts from the EVE Ref archive, part 1: the schema
-- (docs/public-contracts-archive.md). Nothing writes or reads these yet; the
-- public-contracts-archive job that fills them is the next change.
--
-- The archive feeds the existing public_contract and public_contract_item
-- rows (a contract's facts are the same whichever source stored them first)
-- and adds what only it carries: the resolved place, auction bids, and the
-- rolls of mutated (Abyssal) modules. Same conventions as the other
-- public_contract* tables: members read, the service role inserts and updates
-- but is granted no DELETE, and no foreign key cascades.

-- ── public_contract: the resolved place ────────────────────────────────────
-- Filled by EVE Ref only where start_location_id is an NPC station; a
-- contract in a player structure leaves all three null.
alter table public.public_contract
  add column system_id bigint,
  add column constellation_id bigint,
  add column station_id bigint;

create index public_contract_system_id_idx on public.public_contract (system_id);

-- ── public_contract_bid ────────────────────────────────────────────────────
-- One row per bid on an auction. A bid is frozen once placed; a contract's
-- bids only grow.
create table public.public_contract_bid (
  bid_id bigint primary key,
  contract_id bigint not null references public.public_contract (contract_id),
  amount numeric(20, 2) not null,
  date_bid timestamptz not null
);
create index public_contract_bid_contract_id_idx on public.public_contract_bid (contract_id);

-- ── public_contract_dynamic_item: a mutated module on a contract ───────────
-- Keyed on (contract_id, item_id), not item_id alone: a mutated module keeps
-- its item id when it is resold, so the same item turns up on contract after
-- contract, and each of those contracts holds it.
create table public.public_contract_dynamic_item (
  contract_id bigint not null references public.public_contract (contract_id),
  item_id bigint not null,
  -- The module it was before mutation.
  source_type_id bigint not null,
  -- The mutaplasmid applied.
  mutator_type_id bigint not null,
  -- The character who rolled it.
  created_by bigint not null,
  primary key (contract_id, item_id)
);
create index public_contract_dynamic_item_item_id_idx on public.public_contract_dynamic_item (item_id);
create index public_contract_dynamic_item_source_type_id_idx on public.public_contract_dynamic_item (source_type_id);

-- ── The roll: attributes and effects of a mutated item ─────────────────────
-- A mutation is permanent, so these are keyed on the item alone and written
-- once however many contracts the item appears on. No foreign key: the
-- parent's key is (contract_id, item_id), so item_id is not unique there.
create table public.public_contract_dynamic_item_attribute (
  item_id bigint not null,
  attribute_id integer not null,
  value double precision not null,
  primary key (item_id, attribute_id)
);

create table public.public_contract_dynamic_item_effect (
  item_id bigint not null,
  effect_id integer not null,
  is_default boolean not null,
  primary key (item_id, effect_id)
);

-- ── Access ─────────────────────────────────────────────────────────────────
alter table public.public_contract_bid enable row level security;
alter table public.public_contract_dynamic_item enable row level security;
alter table public.public_contract_dynamic_item_attribute enable row level security;
alter table public.public_contract_dynamic_item_effect enable row level security;

create policy "Members read public contract bids" on public.public_contract_bid
  for select to authenticated using (true);
create policy "Members read public contract dynamic items" on public.public_contract_dynamic_item
  for select to authenticated using (true);
create policy "Members read public contract dynamic item attributes" on public.public_contract_dynamic_item_attribute
  for select to authenticated using (true);
create policy "Members read public contract dynamic item effects" on public.public_contract_dynamic_item_effect
  for select to authenticated using (true);

grant select on public.public_contract_bid, public.public_contract_dynamic_item,
  public.public_contract_dynamic_item_attribute, public.public_contract_dynamic_item_effect to authenticated;
grant select, insert, update on public.public_contract_bid, public.public_contract_dynamic_item,
  public.public_contract_dynamic_item_attribute, public.public_contract_dynamic_item_effect to service_role;

-- "The service role may insert and update but never delete" was never true at
-- the grant layer: schema.sql's default privileges hand service_role ALL on
-- every new table, DELETE and TRUNCATE included, and the explicit grants above
-- only add to that. Take both back, here and on the four tables
-- 20261009035853_public_contracts.sql made, so nothing in public_contract* can
-- be deleted short of the table owner.
revoke delete, truncate on public.public_contract, public.public_contract_status_over_time,
  public.public_contract_status, public.public_contract_item, public.public_contract_region,
  public.public_contract_bid, public.public_contract_dynamic_item,
  public.public_contract_dynamic_item_attribute, public.public_contract_dynamic_item_effect
  from service_role;
