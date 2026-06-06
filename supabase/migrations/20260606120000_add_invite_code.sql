-- Invite-only registration. A new account can only be created by redeeming an
-- unused invite code, and users earn the ability to mint codes over time (the
-- first one a week after they add their first character via SSO, then after 2,
-- 4, 8, … weeks — the gap doubling each time; see src/app/account/invite).
--
-- `created_by` is null for seed codes inserted by hand to bootstrap the system
-- (there is no one to invite the very first user). `redeemed_by` is the account
-- that signed up with the code; null while the code is still "to give out".
-- Written idempotently so it is safe to apply to an already-migrated database.
create table if not exists public.invite_code (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  created_by uuid references auth.users(id) on delete cascade,
  redeemed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  redeemed_at timestamptz
);
create index if not exists invite_code_created_by_idx on public.invite_code (created_by);

alter table public.invite_code enable row level security;

-- Users may read the codes they own; minting and redeeming both run server-side
-- with the service role (which enforces the earning schedule and validates codes
-- for not-yet-authenticated registrants), so authenticated users get no write
-- policy and cannot fabricate codes that bypass the schedule.
drop policy if exists "Users read own invite codes" on public.invite_code;
create policy "Users read own invite codes"
  on public.invite_code
  for select
  to authenticated
  using (created_by = (select auth.uid()));

grant select on public.invite_code to authenticated;
grant all    on public.invite_code to service_role;
