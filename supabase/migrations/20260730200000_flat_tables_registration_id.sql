-- Rename character_id to registration_id on every remaining table that has no
-- dependent view or function — step 3 of docs/registration-id-rename.md.
--
-- These seven are batched into one migration deliberately. Each rename PR
-- costs one window where the deployed code and the schema disagree (the
-- Migrate workflow finishes well before Vercel's build), and that cost is per
-- PR rather than per table. Splitting these across seven PRs would multiply
-- the windows without making any single change safer, because none of them
-- can fail in an interesting way: nothing selects from them but their own
-- policies, which follow a rename automatically.
--
-- That is exactly what makes this the low-risk batch. Compare #749, where a
-- view had to be dropped and recreated because `select *` freezes its output
-- column names, and a string-body SQL function had to be recreated because
-- its body is re-parsed at execution and would otherwise have failed at the
-- next query with nothing to catch it at migration time. Neither hazard
-- exists here: verified that no `create view` or `create function` in
-- schema.sql references any of these tables.
--
-- Everything still holding a character_id — the SCD tables behind the
-- is_current views, heartbeat (which feeds latest_heartbeats() and carries a
-- generated owner_key column), and the function signatures — is staged in the
-- doc for later, since each needs objects recreated in a specific order.

alter table public.character_wallet             rename column character_id to registration_id;
alter table public.character_wallet_transaction rename column character_id to registration_id;
alter table public.character_implant            rename column character_id to registration_id;
alter table public.character_location           rename column character_id to registration_id;
alter table public.character_clone_state        rename column character_id to registration_id;
alter table public.corp_wallet_transaction      rename column character_id to registration_id;
alter table public.refresh_task                 rename column character_id to registration_id;

-- Indexes whose names described the old column. The primary keys on
-- character_implant / character_location / character_clone_state are named
-- <table>_pkey, so they need nothing.
alter index if exists public.character_wallet_character_id_recorded_at_idx
  rename to character_wallet_registration_id_recorded_at_idx;
alter index if exists public.character_wallet_transaction_character_id_date_idx
  rename to character_wallet_transaction_registration_id_date_idx;
alter index if exists public.corp_wallet_transaction_character_id_date_idx
  rename to corp_wallet_transaction_registration_id_date_idx;
