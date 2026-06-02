-- Per-user preferences backing the ESI scope checkboxes on the settings page.
-- This table was added to schema.sql in #349 but never shipped as an incremental
-- migration, so databases updated via `supabase db push` (rather than a full,
-- destructive schema.sql reset) never got it. Without the table, getEnabledScopes
-- silently fell back to "request everything" (every box checked) and saving
-- preferences failed, so the settings checkboxes never reflected what the user
-- had chosen. Mirrors the definition in schema.sql, written idempotently so it is
-- safe to apply to databases that already have the table.
create table if not exists public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  enabled_scopes text[] not null default '{}',
  updated_at timestamptz not null default now()
);

alter table public.user_settings enable row level security;

drop policy if exists "Users manage own settings" on public.user_settings;
create policy "Users manage own settings"
  on public.user_settings
  for all
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

grant select, insert, update, delete on public.user_settings to authenticated;
grant all                            on public.user_settings to service_role;
