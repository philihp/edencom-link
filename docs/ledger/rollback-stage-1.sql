-- Rollback of ledger stage 1 (migration 20261119091512_ledger_check.sql).
-- Step (c) of the plan's rollback: turn the `ledger` flag off and remove the
-- ledger-check cron entry first.
--
-- It drops only the three stage 1 tables. No source table is touched, so no
-- journal history can be lost. corp_wallet holds balance snapshots that ESI
-- does not keep: copy it out first if it is to be kept.
--
-- To roll back in production, add this as a NEW migration (never edit or
-- rename the stage 1 migration; CLAUDE.md).
drop table if exists public.ledger_check;
drop table if exists public.ledger_wallet_segment;
drop table if exists public.corp_wallet;
