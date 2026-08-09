-- Contract collection: ESI /characters/{id}/contracts/ and
-- /corporations/{id}/contracts/, plus the per-contract item lists, pulled by the
-- character-contracts and corp-contracts jobs on the same 6-hourly cadence as
-- the wallet-transaction extracts.
--
-- Unlike a wallet transaction, a contract is *mutable* — it moves outstanding →
-- in_progress → finished/failed/deleted and gains an acceptor and completion
-- date along the way — so these are plain upsert-in-place tables, not
-- append-only ones. The tracked history that matters (issue/accept/complete
-- timestamps) is carried by the row's own columns, so an SCD-2 pair would only
-- record the state machine ESI already dates for us.
--
-- contract_id is globally unique in EVE but a contract is visible to *both*
-- parties, so the key is (owner, contract_id) rather than contract_id alone:
-- issuer and acceptor may be characters on different accounts here, and each
-- has to get their own RLS-visible copy rather than the first scanner claiming
-- the row and hiding it from the counterparty.

-- ── character_contract ────────────────────────────────────────────────────
create table if not exists public.character_contract (
  registration_id uuid not null references public.registration(id) on delete cascade,
  contract_id bigint not null,
  -- ESI enums, kept as text: unknown/item_exchange/auction/courier/loan and
  -- outstanding/in_progress/finished_issuer/finished_contractor/finished/
  -- cancelled/rejected/failed/deleted/reversed. Stored raw so a new member CCP
  -- adds lands in the table instead of failing the extract.
  type text not null,
  status text not null,
  availability text not null,
  for_corporation boolean not null default false,
  issuer_id bigint not null,
  issuer_corporation_id bigint not null,
  assignee_id bigint,
  acceptor_id bigint,
  start_location_id bigint,
  end_location_id bigint,
  title text,
  price numeric(20, 2),
  reward numeric(20, 2),
  collateral numeric(20, 2),
  buyout numeric(20, 2),
  volume double precision,
  days_to_complete integer,
  date_issued timestamptz not null,
  date_expired timestamptz not null,
  date_accepted timestamptz,
  date_completed timestamptz,
  -- When this contract's item list was pulled (or definitively found
  -- unreadable). Null means "still owed an items fetch"; the extract only ever
  -- asks ESI for items once per contract, since a contract's contents never
  -- change after it is created.
  items_fetched_at timestamptz,
  seen_at timestamptz not null default now(),
  primary key (registration_id, contract_id)
);
create index if not exists character_contract_registration_id_date_issued_idx
  on public.character_contract (registration_id, date_issued desc);
-- The extract's "what still needs items?" probe, run once per character per run.
create index if not exists character_contract_items_pending_idx
  on public.character_contract (registration_id) where items_fetched_at is null;

alter table public.character_contract enable row level security;
drop policy if exists "Users read own contracts" on public.character_contract;
create policy "Users read own contracts"
  on public.character_contract
  for select
  to authenticated
  using (
    registration_id in (
      select id from public.registration where user_id = (select auth.uid())
    )
  );

grant select on public.character_contract to authenticated;
grant all    on public.character_contract to service_role;

-- ── character_contract_item ───────────────────────────────────────────────
-- One row per line item of a contract. raw_quantity is ESI's blueprint marker
-- (-1 original, -2 copy) and is absent for ordinary items.
create table if not exists public.character_contract_item (
  registration_id uuid not null,
  contract_id bigint not null,
  record_id bigint not null,
  type_id bigint not null,
  quantity bigint not null,
  is_included boolean not null,
  is_singleton boolean not null,
  raw_quantity bigint,
  seen_at timestamptz not null default now(),
  primary key (registration_id, contract_id, record_id),
  foreign key (registration_id, contract_id)
    references public.character_contract (registration_id, contract_id) on delete cascade
);
create index if not exists character_contract_item_type_id_idx on public.character_contract_item (type_id);

alter table public.character_contract_item enable row level security;
drop policy if exists "Users read own contract items" on public.character_contract_item;
create policy "Users read own contract items"
  on public.character_contract_item
  for select
  to authenticated
  using (
    registration_id in (
      select id from public.registration where user_id = (select auth.uid())
    )
  );

grant select on public.character_contract_item to authenticated;
grant all    on public.character_contract_item to service_role;

-- ── corp_contract ─────────────────────────────────────────────────────────
-- The corporation mirror, keyed on the corporation rather than the scanning
-- character: whichever of the caller's characters holds the scope this run, the
-- corp's contract set is the same one. `registration_id` records which
-- registration's token last scanned the row (last scanner wins), matching
-- corp_wallet_transaction's attribution column; RLS scopes reads by corporation
-- like corp_wallet_journal, so every member of the corp who has linked a
-- character sees it.
create table if not exists public.corp_contract (
  corporation_id bigint not null,
  contract_id bigint not null,
  registration_id uuid not null references public.registration(id) on delete cascade,
  type text not null,
  status text not null,
  availability text not null,
  for_corporation boolean not null default false,
  issuer_id bigint not null,
  issuer_corporation_id bigint not null,
  assignee_id bigint,
  acceptor_id bigint,
  start_location_id bigint,
  end_location_id bigint,
  title text,
  price numeric(20, 2),
  reward numeric(20, 2),
  collateral numeric(20, 2),
  buyout numeric(20, 2),
  volume double precision,
  days_to_complete integer,
  date_issued timestamptz not null,
  date_expired timestamptz not null,
  date_accepted timestamptz,
  date_completed timestamptz,
  items_fetched_at timestamptz,
  seen_at timestamptz not null default now(),
  primary key (corporation_id, contract_id)
);
create index if not exists corp_contract_corporation_id_date_issued_idx
  on public.corp_contract (corporation_id, date_issued desc);
create index if not exists corp_contract_items_pending_idx
  on public.corp_contract (corporation_id) where items_fetched_at is null;

alter table public.corp_contract enable row level security;
drop policy if exists "Users read own corp contracts" on public.corp_contract;
create policy "Users read own corp contracts"
  on public.corp_contract
  for select
  to authenticated
  using (
    corporation_id in (
      select corporation_id from public.registration
      where user_id = (select auth.uid()) and corporation_id is not null
    )
  );

grant select on public.corp_contract to authenticated;
grant all    on public.corp_contract to service_role;

-- ── corp_contract_item ────────────────────────────────────────────────────
create table if not exists public.corp_contract_item (
  corporation_id bigint not null,
  contract_id bigint not null,
  record_id bigint not null,
  type_id bigint not null,
  quantity bigint not null,
  is_included boolean not null,
  is_singleton boolean not null,
  raw_quantity bigint,
  seen_at timestamptz not null default now(),
  primary key (corporation_id, contract_id, record_id),
  foreign key (corporation_id, contract_id)
    references public.corp_contract (corporation_id, contract_id) on delete cascade
);
create index if not exists corp_contract_item_type_id_idx on public.corp_contract_item (type_id);

alter table public.corp_contract_item enable row level security;
drop policy if exists "Users read own corp contract items" on public.corp_contract_item;
create policy "Users read own corp contract items"
  on public.corp_contract_item
  for select
  to authenticated
  using (
    corporation_id in (
      select corporation_id from public.registration
      where user_id = (select auth.uid()) and corporation_id is not null
    )
  );

grant select on public.corp_contract_item to authenticated;
grant all    on public.corp_contract_item to service_role;
