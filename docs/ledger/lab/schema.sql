-- The ledger lab: stand-in tables for the copy that src/ledger/labCopy.ts
-- writes (docs/ledger/lab.md). Run ONLY on a database on your own computer:
-- `pnpm run ledger-lab -- load` checks the host before it runs this file.
--
-- All lab tables live in the schema `ledger_lab`, so the lab can share a
-- local Supabase stack with the app's own tables and never touch them. The
-- schema is dropped and made again on each load. The columns and keys are the
-- production ones (schema.sql), with no foreign keys, no RLS and no indexes
-- other than the primary keys: the lab is read by one person.

drop schema if exists ledger_lab cascade;
create schema ledger_lab;

create table ledger_lab.registration (
  id uuid primary key,
  character_id bigint not null,
  corporation_id bigint,
  is_main boolean
);

create table ledger_lab.character_wallet (
  id uuid primary key,
  registration_id uuid not null,
  balance numeric(20, 2) not null,
  recorded_at timestamptz not null
);

create table ledger_lab.character_wallet_journal (
  registration_id uuid not null,
  entry_id bigint not null,
  date timestamptz not null,
  ref_type text not null,
  amount numeric(20, 2),
  balance numeric(20, 2),
  first_party_id bigint,
  second_party_id bigint,
  context_id bigint,
  context_id_type text,
  tax numeric(20, 2),
  tax_receiver_id bigint,
  seen_at timestamptz not null,
  primary key (registration_id, entry_id)
);

create table ledger_lab.corp_wallet_journal (
  corporation_id bigint not null,
  division smallint not null,
  entry_id bigint not null,
  date timestamptz not null,
  ref_type text not null,
  amount numeric(20, 2),
  balance numeric(20, 2),
  first_party_id bigint,
  second_party_id bigint,
  context_id bigint,
  context_id_type text,
  tax numeric(20, 2),
  tax_receiver_id bigint,
  seen_at timestamptz not null,
  primary key (corporation_id, division, entry_id)
);

-- transaction_id alone is the key, as in production: census question H5 asks
-- what that key loses.
create table ledger_lab.character_wallet_transaction (
  transaction_id bigint primary key,
  registration_id uuid not null,
  date timestamptz not null,
  type_id bigint not null,
  quantity bigint not null,
  unit_price numeric(20, 2) not null,
  is_buy boolean not null,
  client_id bigint not null,
  location_id bigint not null,
  journal_ref_id bigint not null,
  seen_at timestamptz not null,
  is_personal boolean not null
);

create table ledger_lab.corp_wallet_transaction (
  transaction_id bigint primary key,
  registration_id uuid not null,
  date timestamptz not null,
  type_id bigint not null,
  quantity bigint not null,
  unit_price numeric(20, 2) not null,
  is_buy boolean not null,
  client_id bigint not null,
  location_id bigint not null,
  journal_ref_id bigint not null,
  seen_at timestamptz not null,
  corporation_id bigint not null,
  division smallint not null
);

-- The contract and industry job tables, one JSON document per row. Stage 3
-- decides which columns it needs; the census does not read them.
create table ledger_lab.raw_character_contract (doc jsonb not null);
create table ledger_lab.raw_corp_contract (doc jsonb not null);
create table ledger_lab.raw_character_contract_item (doc jsonb not null);
create table ledger_lab.raw_corp_contract_item (doc jsonb not null);
create table ledger_lab.raw_character_contract_status_over_time (doc jsonb not null);
create table ledger_lab.raw_corp_contract_status_over_time (doc jsonb not null);
create table ledger_lab.raw_character_industry_job_over_time (doc jsonb not null);
create table ledger_lab.raw_corp_industry_job_over_time (doc jsonb not null);

-- Stage 2 (docs/ledger/stage-2.md). The director proof of ledger_group(), and
-- the stage 1 evidence that a month is "proven" from. `pending_credits` and
-- `reasons` are arrays in production; the copy writes them as JSON.
create table ledger_lab.corp_job_access (
  registration_id uuid not null,
  corporation_id bigint not null,
  job text not null,
  observed_at timestamptz not null,
  primary key (registration_id, corporation_id, job)
);

create table ledger_lab.ledger_wallet_segment (
  id bigint primary key,
  registration_id uuid,
  corporation_id bigint,
  division smallint,
  first_entry_id bigint not null,
  last_entry_id bigint not null,
  first_date timestamptz not null,
  last_date timestamptz not null,
  opening numeric(20, 2) not null,
  closing numeric(20, 2) not null,
  row_count integer not null,
  rounding_steps integer not null,
  hidden_credit_steps integer not null,
  pending_credits jsonb not null,
  computed_at timestamptz not null
);

create table ledger_lab.ledger_check (
  id bigint primary key,
  registration_id uuid,
  corporation_id bigint,
  division smallint,
  checked_at timestamptz not null,
  ok boolean not null,
  segments integer not null,
  new_breaks integer not null,
  rounding_steps integer not null,
  hidden_credit_steps integer not null,
  rows_read integer not null,
  rebuilt boolean not null,
  newest_entry_id bigint,
  newest_entry_date timestamptz,
  last_pull_at timestamptz,
  snapshot_compare text,
  snapshot_difference numeric(20, 2),
  reasons jsonb not null
);
