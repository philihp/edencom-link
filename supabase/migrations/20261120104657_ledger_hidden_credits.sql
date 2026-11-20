-- Ledger stage 1: hidden credits (docs/ledger/stage-1.md, "Hidden credits").
-- A corporation that pays facility tax to itself gets the tax back with no
-- journal row. The chain counts those steps and carries the credits still
-- due from one run to the next. Additive only: two columns with defaults on
-- ledger_wallet_segment, one on ledger_check. Both tables are empty in
-- production (no cron yet), so nothing is rewritten.
alter table public.ledger_wallet_segment
  add column hidden_credit_steps integer not null default 0 check (hidden_credit_steps >= 0),
  add column pending_credits numeric(20, 2)[] not null default '{}';

alter table public.ledger_check
  add column hidden_credit_steps integer not null default 0 check (hidden_credit_steps >= 0);
