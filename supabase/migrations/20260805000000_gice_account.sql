-- GICE (Goonfleet SSO) as an auth method (docs/gice-auth.md): one row links a
-- Supabase account to a GICE (goonfleet.com) forum account. gice_id is the
-- OIDC `sub` claim. Written only by the server (service role) after a
-- verified OAuth callback — either registering a new account or linking GICE
-- to an existing one from settings; owners read their own row from settings.
-- name / primary_group are display-only, refreshed on each sign-in.

create table public.gice_account (
  gice_id bigint primary key,
  user_id uuid not null unique references auth.users(id) on delete cascade,
  name text,
  primary_group text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.gice_account enable row level security;
create policy "Users read own GICE link"
  on public.gice_account
  for select
  to authenticated
  using (user_id = (select auth.uid()));

grant select on public.gice_account to authenticated;
grant all    on public.gice_account to service_role;
