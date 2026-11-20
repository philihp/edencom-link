-- Ledger stage 1: the evidence layer (docs/ledger/plan.md layer 0;
-- docs/ledger/stage-1.md).
--
-- Three new tables. None of them is a source table, and nothing here reads or
-- changes a row of the five wallet tables (guard C1).
--
--   corp_wallet            the corporation wallet balance, one row per
--                          division per corp-wallet-journal run. The
--                          independent control for corporation wallets (I-9).
--   ledger_wallet_segment  the proven spans of each wallet journal: a few rows
--                          per wallet.
--   ledger_check           one row per wallet per run of the ledger-check job.
--
-- RLS: a row is readable by whoever can read the journal it was made from
-- (the character's account, or a member of the corporation). No anon grant.
-- Writes are service-role only (the extract and the ledger-check job).
--
-- Rollback: docs/ledger/rollback-stage-1.sql (tested in test/sql/ledger_check.sql).

-- ── corp_wallet ───────────────────────────────────────────────────────────
-- ESI /corporations/{id}/wallets/, written by the corp-wallet-journal job
-- after it pulls the journal (same scope, same in-game roles).
create table public.corp_wallet (
  id uuid primary key default gen_random_uuid(),
  corporation_id bigint not null,
  division smallint not null check (division between 1 and 7),
  balance numeric(20, 2) not null,
  recorded_at timestamptz not null default now()
);
create index corp_wallet_corp_division_recorded_at_idx
  on public.corp_wallet (corporation_id, division, recorded_at desc);

alter table public.corp_wallet enable row level security;
create policy "Users read wallets of own corps"
  on public.corp_wallet
  for select
  to authenticated
  using (corporation_id in (select public.my_corporation_ids()));

grant select on public.corp_wallet to authenticated;
grant all    on public.corp_wallet to service_role;

-- ── ledger_wallet_segment ─────────────────────────────────────────────────
-- A segment is a longest run of journal rows where
--   balance(n) = balance(n-1) + amount(n)
-- holds (a step off by exactly one cent is rounding and holds; owner decision
-- 2026-11-19). Inside a segment the journal is proven complete. The pure fold
-- is src/ledger/chain.ts. A wallet is a character (registration_id) or one
-- division of a corporation (corporation_id, division); wallet_key folds the
-- two into one text key.
create table public.ledger_wallet_segment (
  id bigint generated always as identity primary key,
  registration_id uuid references public.registration(id) on delete cascade,
  corporation_id bigint,
  division smallint,
  wallet_key text generated always as (
    coalesce(registration_id::text, corporation_id::text || ':' || division::text)
  ) stored,
  first_entry_id bigint not null,
  last_entry_id bigint not null,
  first_date timestamptz not null,
  last_date timestamptz not null,
  opening numeric(20, 2) not null,
  closing numeric(20, 2) not null,
  row_count integer not null check (row_count > 0),
  rounding_steps integer not null default 0 check (rounding_steps >= 0),
  computed_at timestamptz not null default now(),
  constraint ledger_wallet_segment_one_owner check (
    (registration_id is not null and corporation_id is null and division is null)
    or (registration_id is null and corporation_id is not null and division between 1 and 7)
  ),
  constraint ledger_wallet_segment_order check (first_entry_id <= last_entry_id and first_date <= last_date),
  constraint ledger_wallet_segment_key unique (wallet_key, first_entry_id)
);
create index ledger_wallet_segment_corporation_idx
  on public.ledger_wallet_segment (corporation_id) where corporation_id is not null;

alter table public.ledger_wallet_segment enable row level security;
create policy "Users read segments of own wallets"
  on public.ledger_wallet_segment
  for select
  to authenticated
  using (
    registration_id in (select id from public.registration where user_id = (select auth.uid()))
    or corporation_id in (select public.my_corporation_ids())
  );

grant select on public.ledger_wallet_segment to authenticated;
grant all    on public.ledger_wallet_segment to service_role;

-- ── ledger_check ──────────────────────────────────────────────────────────
-- One row per wallet per run of ledger-check: what the run read, what it
-- found, and whether the wallet passes. `reasons` says why it does not.
create table public.ledger_check (
  id bigint generated always as identity primary key,
  registration_id uuid references public.registration(id) on delete cascade,
  corporation_id bigint,
  division smallint,
  wallet_key text generated always as (
    coalesce(registration_id::text, corporation_id::text || ':' || division::text)
  ) stored,
  checked_at timestamptz not null default now(),
  ok boolean not null,
  segments integer not null check (segments >= 0),
  new_breaks integer not null check (new_breaks >= 0),
  rounding_steps integer not null default 0 check (rounding_steps >= 0),
  rows_read integer not null check (rows_read >= 0),
  rebuilt boolean not null default false,
  newest_entry_id bigint,
  newest_entry_date timestamptz,
  last_pull_at timestamptz,
  snapshot_compare text check (snapshot_compare in ('equal', 'one_cent', 'differs', 'none')),
  snapshot_difference numeric(20, 2),
  reasons text[] not null default '{}',
  constraint ledger_check_one_owner check (
    (registration_id is not null and corporation_id is null and division is null)
    or (registration_id is null and corporation_id is not null and division between 1 and 7)
  )
);
create index ledger_check_wallet_checked_at_idx on public.ledger_check (wallet_key, checked_at desc);
create index ledger_check_corporation_idx
  on public.ledger_check (corporation_id) where corporation_id is not null;

alter table public.ledger_check enable row level security;
create policy "Users read checks of own wallets"
  on public.ledger_check
  for select
  to authenticated
  using (
    registration_id in (select id from public.registration where user_id = (select auth.uid()))
    or corporation_id in (select public.my_corporation_ids())
  );

grant select on public.ledger_check to authenticated;
grant all    on public.ledger_check to service_role;
