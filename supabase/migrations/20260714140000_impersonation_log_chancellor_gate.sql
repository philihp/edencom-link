-- Impersonation on /account/debug is now gated by Chancellor status
-- (isChancellor(), see src/app/account/debug/impersonate.ts) instead of one
-- hardcoded account, so the audit column it writes to no longer means "the
-- admin" specifically — rename it to say what it actually records.
alter table public.impersonation_log rename column admin_user_id to chancellor_user_id;
