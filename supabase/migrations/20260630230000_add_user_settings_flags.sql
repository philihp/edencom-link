-- The set of Vercel Flags (src/flags.ts) a user has enabled, e.g. 'indexes'
-- gates the /indexes page and nav link per-user. Mirrors the column added to
-- schema.sql, written idempotently so it is safe to apply to an
-- already-migrated database.
alter table public.user_settings
  add column if not exists flags text[] not null default '{}';
