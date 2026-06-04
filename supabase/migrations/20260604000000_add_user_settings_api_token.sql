-- Per-user secret for the Google Sheets ImportJSON endpoint (/api/assets). The
-- request carries no Supabase session, so the route resolves the user by this
-- token (service role) and scopes results to their characters. The unique
-- constraint doubles as the lookup index. Null until generated in settings.
alter table public.user_settings
  add column if not exists api_token text unique;
