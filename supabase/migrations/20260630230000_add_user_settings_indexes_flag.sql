-- Backs the "indexes" Vercel Flag (src/flags.ts), gating the /indexes page and
-- nav link per-user. Mirrors the column added to schema.sql, written
-- idempotently so it is safe to apply to an already-migrated database.
alter table public.user_settings
  add column if not exists indexes boolean not null default false;
