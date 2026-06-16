-- The user's chosen "main" character. At most one registration per user is the
-- main; the /character page's "Set as Main" control clears the others. Used to
-- label an account by a single name — e.g. who invited a given account, shown on
-- /account/invite. Mirrors the column added to schema.sql, written idempotently.
-- No grant changes: it's a user-writable preference on rows the existing "Users
-- manage own characters" RLS policy already scopes to the owner.
alter table public.registration
  add column if not exists is_main boolean not null default false;
