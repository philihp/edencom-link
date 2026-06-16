-- Chancellor: an account flagged with elevated powers. The first such power is
-- minting invite codes without waiting on the per-user earning schedule (see
-- src/app/account/invite), plus granting/revoking Chancellor on other accounts
-- (src/app/account/chancellor). Mirrors the column added to schema.sql, written
-- idempotently so it is safe to apply to an already-migrated database.
alter table public.user_settings
  add column if not exists is_chancellor boolean not null default false;

-- Lock the flag down. Authenticated users may read their own row (so the UI can
-- tell them they are a Chancellor) but must NOT be able to write is_chancellor —
-- otherwise the existing "Users manage own settings" RLS policy would let them
-- promote themselves. Replace the table-wide insert/update grants with
-- column-level grants that deliberately omit is_chancellor; only the service role
-- (which the grant action uses) can change it. select/delete grants are
-- unaffected and remain in place from the original migration.
revoke insert, update on public.user_settings from authenticated;
grant insert (user_id, enabled_scopes, api_token, updated_at) on public.user_settings to authenticated;
grant update (enabled_scopes, api_token, updated_at)          on public.user_settings to authenticated;
