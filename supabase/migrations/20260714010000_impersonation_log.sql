-- Admin-impersonation audit trail: one row per magic-link impersonation session
-- minted via /account/debug (see src/app/account/debug/impersonate.ts).
-- Internal-only, service-role bookkeeping — RLS is on with no policy, mirroring
-- esi_etag, so neither the admin nor the impersonated user can read it through
-- the API.
create table public.impersonation_log (
  id uuid primary key default gen_random_uuid(),
  admin_user_id uuid not null references auth.users(id) on delete cascade,
  target_user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index impersonation_log_target_user_id_idx on public.impersonation_log (target_user_id);

alter table public.impersonation_log enable row level security;
grant all on public.impersonation_log to service_role;
