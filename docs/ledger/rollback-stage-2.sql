-- Rollback of ledger stage 2 (docs/ledger/stage-2.md): the cash ledger view.
-- Apply as a NEW migration (never edit or rename the original). It drops
-- the two functions, the view and the two seed tables. It names no source
-- table, and stage 1 is left as it is. Tested in test/sql/ledger_cash.sql.
drop function if exists public.ledger_cash_statement(date, date, text, text);
drop function if exists public.ledger_group();
drop view if exists public.ledger_cash_line;
drop table if exists public.ledger_ref_type;
drop table if exists public.ledger_account;
