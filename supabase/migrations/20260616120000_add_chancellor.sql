-- Chancellor: a flag on invite_code marking it as conferring Chancellor powers.
-- An account is a Chancellor when it has redeemed (burned) an invite_code whose
-- is_chancellor is true; that lets it mint invite codes without waiting on the
-- earning schedule and grant/revoke Chancellor on other accounts (see
-- src/app/account/chancellor). Mirrors the column added to schema.sql, written
-- idempotently so it is safe to apply to an already-migrated database.
--
-- No grant changes: invite_code is service-role-write only — authenticated users
-- have just a read-only "own codes" policy and no insert/update privilege — so
-- the flag can only ever be set by the service role.
alter table public.invite_code
  add column if not exists is_chancellor boolean not null default false;
