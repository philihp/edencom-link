-- SQL-level coverage for the ledger census (docs/ledger/census_views.sql,
-- docs/ledger/plan.md stage 0). The census reads no app object and writes
-- nothing; these rows have answers worked out by hand, and each check below
-- names the question (H1 to H11) it pins.
--
-- Run against a THROWAWAY database from the repo root:
--
--   DATABASE_URL='postgresql://…/throwaway' pnpm run test:sql
--
-- The stand-in tables live in a schema made inside one transaction, which
-- rolls back.
begin;

create schema ledger_census_test;
set local search_path = ledger_census_test;

create table registration (id uuid primary key, character_id bigint not null, corporation_id bigint, is_main boolean);
create table character_wallet (id uuid primary key, registration_id uuid not null, balance numeric(20, 2) not null, recorded_at timestamptz not null);
create table character_wallet_journal (
  registration_id uuid not null, entry_id bigint not null, date timestamptz not null, ref_type text not null,
  amount numeric(20, 2), balance numeric(20, 2), first_party_id bigint, second_party_id bigint,
  context_id bigint, context_id_type text, tax numeric(20, 2), tax_receiver_id bigint, seen_at timestamptz not null,
  primary key (registration_id, entry_id)
);
create table corp_wallet_journal (
  corporation_id bigint not null, division smallint not null, entry_id bigint not null, date timestamptz not null,
  ref_type text not null, amount numeric(20, 2), balance numeric(20, 2), first_party_id bigint, second_party_id bigint,
  context_id bigint, context_id_type text, tax numeric(20, 2), tax_receiver_id bigint, seen_at timestamptz not null,
  primary key (corporation_id, division, entry_id)
);
create table character_wallet_transaction (
  transaction_id bigint primary key, registration_id uuid not null, date timestamptz not null, type_id bigint not null,
  quantity bigint not null, unit_price numeric(20, 2) not null, is_buy boolean not null, client_id bigint not null,
  location_id bigint not null, journal_ref_id bigint not null, seen_at timestamptz not null, is_personal boolean not null
);
create table corp_wallet_transaction (
  transaction_id bigint primary key, registration_id uuid not null, date timestamptz not null, type_id bigint not null,
  quantity bigint not null, unit_price numeric(20, 2) not null, is_buy boolean not null, client_id bigint not null,
  location_id bigint not null, journal_ref_id bigint not null, seen_at timestamptz not null,
  corporation_id bigint not null, division smallint not null
);

-- Two characters (9001 in corporation 98000001, and 9002) and one division of
-- the corporation. 7777 is an outsider.
insert into registration values
  ('00000000-0000-0000-0000-000000000001', 9001, 98000001, true),
  ('00000000-0000-0000-0000-000000000002', 9002, null, false);

-- Character 9001: 10 → 11 → 12 chain; 14 follows a gap of +20 ISK; 15 has no
-- amount or balance; 16 starts again after it, dated before 15 (H1).
-- 10 is a donation from 9002 (same entry id on both sides, H4), first seen
-- 40 days late (an imported row, H8). 11 is a sale to 9002 (H5). 12 has a
-- tax and moves the balance by amount (H3).
insert into character_wallet_journal values
  ('00000000-0000-0000-0000-000000000001', 10, '2026-01-01 00:00Z', 'player_donation', 100, 100, 9002, 9001, null, null, null, null, '2026-02-10 00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 11, '2026-01-01 01:00Z', 'market_transaction', 50, 150, 9002, 9001, 500, 'market_transaction_id', null, null, '2026-01-01 02:00Z'),
  ('00000000-0000-0000-0000-000000000001', 12, '2026-01-01 02:00Z', 'bounty_prizes', 20, 170, 1000125, 9001, null, null, 2, 1000125, '2026-01-01 03:00Z'),
  ('00000000-0000-0000-0000-000000000001', 14, '2026-01-01 04:00Z', 'player_donation', 10, 200, 7777, 9001, null, null, null, null, '2026-01-01 05:00Z'),
  ('00000000-0000-0000-0000-000000000001', 15, '2026-01-01 05:00Z', 'player_donation', null, null, 7777, 9001, null, null, null, null, '2026-01-01 06:00Z'),
  ('00000000-0000-0000-0000-000000000001', 16, '2026-01-01 04:30Z', 'player_donation', 5, 205, 7777, 9001, null, null, null, null, '2026-01-01 06:00Z');

-- Character 9002: the other side of donation 10 and of trade 500.
insert into character_wallet_journal values
  ('00000000-0000-0000-0000-000000000002', 10, '2026-01-01 00:00Z', 'player_donation', -100, 1000, 9002, 9001, null, null, null, null, '2026-01-01 01:00Z'),
  ('00000000-0000-0000-0000-000000000002', 11, '2026-01-01 01:00Z', 'market_transaction', -50, 950, 9002, 9001, 500, 'market_transaction_id', null, null, '2026-01-01 02:00Z');

-- The corporation: a withdrawal to 9001 that 9001's journal does not show
-- (H4 `missing`), and a sale to the outsider.
insert into corp_wallet_journal values
  (98000001, 1, 30, '2026-01-01 03:00Z', 'corporation_account_withdrawal', -40, 960, 98000001, 9001, null, null, null, null, '2026-01-01 04:00Z'),
  (98000001, 1, 31, '2026-01-01 03:30Z', 'market_transaction', 30, 990, 7777, 98000001, 600, 'market_transaction_id', null, null, '2026-01-01 04:00Z');

-- Trade 500 is stored once, for the buyer 9002: the key transaction_id alone
-- kept no row for the seller 9001 (H5).
insert into character_wallet_transaction values
  (500, '00000000-0000-0000-0000-000000000002', '2026-01-01 01:00Z', 34, 5, 10, true, 9001, 60003760, 11, '2026-01-01 02:00Z', true);
insert into corp_wallet_transaction values
  (600, '00000000-0000-0000-0000-000000000001', '2026-01-01 03:30Z', 34, 3, 10, false, 7777, 60003760, 31, '2026-01-01 04:00Z', 98000001, 1);

-- Snapshots: before any journal row; equal; and one that differs.
insert into character_wallet values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 50, '2025-12-31 00:00Z'),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000002', 950, '2026-01-01 01:00:10Z'),
  ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 999, '2026-01-01 12:00Z');

\ir ../../docs/ledger/census_views.sql

do $$
declare
  got record;
  n bigint;
begin
  -- Segments (layer 0): 9001 has three, 9002 one, the division one.
  select count(*) into n from census_segment where wallet_key = '00000000-0000-0000-0000-000000000001';
  assert n = 3, format('9001 should have 3 segments, has %s', n);
  select count(*) into n from census_segment;
  assert n = 5, format('5 segments in all, got %s', n);
  select * into got from census_segment
    where wallet_key = '00000000-0000-0000-0000-000000000001' and first_entry_id = 10;
  assert got.opening = 0 and got.closing = 170 and got.rows = 3 and got.amount_sum = 170,
    format('first segment of 9001: %s', got);

  -- H1: one pair runs back in time (15 → 16).
  select * into got from census_h1 where wallet_kind = 'character';
  assert got.pairs_time_backwards = 1 and got.wallets_time_backwards = 1, format('H1: %s', got);

  -- H2: one gap (filed under 14's ref_type), one null amount and balance.
  select sum(fails), sum(null_amount), sum(null_balance) into got from census_h2;
  assert got.sum = 1, format('H2 fails: %s', got);
  select sum(fails_one_cent) into n from census_h2;
  assert n = 0, 'H2: the 20 ISK gap is not rounding';
  select fails into n from census_h2 where ref_type = 'player_donation';
  assert n = 1, 'H2: the fail is filed under player_donation';
  select hold_percent into got from census_h2_wallet where wallet_label = 'character #1';
  -- 9001: chainable pairs 10→11, 11→12, 12→14 (fail); 14→15, 15→16 are not chainable.
  assert got.hold_percent = 66.667, format('H2 9001 hold percent: %s', got);

  -- H3: the taxed row moves by amount.
  select * into got from census_h3 where ref_type = 'bounty_prizes';
  assert got.moves_by_amount = 1 and got.moves_by_amount_minus_tax = 0, format('H3: %s', got);

  -- H4: the donation pairs on one entry id, both sides; the withdrawal has no
  -- other side; the sale 11 also shares its entry id.
  select rows into n from census_h4 where ref_type = 'player_donation' and pairing = 'same_entry';
  assert n = 2, format('H4 donation pairs: %s', n);
  select rows into n from census_h4 where ref_type = 'corporation_account_withdrawal' and pairing = 'missing';
  assert n = 1, format('H4 missing withdrawal: %s', n);

  -- H5: the seller's row names a transaction stored for the buyer.
  select journal_rows into n from census_h5 where storage = 'stored_for_another_wallet' and counterparty_is_ours;
  assert n = 1, format('H5 stored for another wallet: %s', n);
  select journal_pairs_naming_one_transaction into n from census_h5_pair;
  assert n = 1, format('H5 pairs: %s', n);

  -- H6: both stored transactions agree with their journal rows, sign and all.
  select sum(transactions) into n from census_h6 where agreement = 'amount_is_signed_quantity_x_price';
  assert n = 2, format('H6 agreement: %s', n);
  select * into got from census_h6_link;
  assert got.transactions = 2 and got.linked_by_journal_ref_id = 2 and got.context_id_names_it_back = 2,
    format('H6 links: %s', got);

  -- H7: market_transaction carries market_transaction_id.
  select rows into n from census_h7 where ref_type = 'market_transaction' and context_id_type = 'market_transaction_id';
  assert n = 3, format('H7: %s', n);

  -- H8: one imported row.
  select rows into n from census_h8 where source = 'imported';
  assert n = 1, format('H8 imported rows: %s', n);

  -- H9: one snapshot of each kind.
  select count(*) into n from census_h9 where snapshots = 1;
  assert n = 3, format('H9: three kinds, one snapshot each, got %s', n);
  select snapshots into n from census_h9 where compare = 'equal';
  assert n = 1, 'H9 equal';
  select snapshots into n from census_h9 where compare = 'no_journal_before';
  assert n = 1, 'H9 no journal before';

  -- H10: the corporation's withdrawal goes out.
  select rows into n from census_h10
    where ref_type = 'corporation_account_withdrawal' and wallet_kind = 'corporation' and direction = 'out';
  assert n = 1, 'H10';

  -- H11: the gaps of 9001 leave out 20 ISK (14) and 0 after the null row
  -- (16 opens at 200, the closing before it).
  select * into got from census_h11_wallet where wallet_label = 'character #1';
  assert got.segments = 3 and got.gap_isk = 20, format('H11: %s', got);

  -- No view shows an id: labels only.
  select count(*) into n from census_h2_wallet where wallet_label like '%9001%' or wallet_label like '%98000001%';
  assert n = 0, 'labels carry no id';
end $$;

rollback;
