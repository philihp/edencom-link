-- Open registration, stage 1: an account can now come into existence before its
-- owner has an identity to hang on it, so that EVE SSO, email, Discord and GICE
-- can each start one (docs/open-registration.md). The account is a Supabase
-- anonymous user, minted lazily — when someone starts adding a character or
-- signing up, never on a page view.
--
-- Three things happen here:
--   1. invite_code.redeemed_by gains the constraint its meaning always implied
--      — one referral per account;
--   2. the RLS audit that anonymous users force: `authenticated` no longer
--      means "a member", so the three tables readable by any authenticated
--      caller learn to ask our question instead;
--   3. the sweep query behind the nightly anon-sweep job.

-- ── 1. one referral per account ───────────────────────────────────────────
-- redeemed_by names the account a code referred. Nothing enforced "at most one
-- per account" while the only writer was sign-up, which writes it once; as the
-- later stages let an account be created by any of four identity flows and
-- referred separately, the index is what keeps that true.
--
-- Partial, because unredeemed codes (the pool) are all null and must stay
-- freely duplicable.
create unique index if not exists invite_code_redeemed_by_key
  on public.invite_code (redeemed_by)
  where redeemed_by is not null;

comment on column public.invite_code.redeemed_by is
  'The account this code referred. Unique, so an account carries at most one referral. '
  'Null while the code is still to give out — `on delete set null` returns it to the pool '
  'when a never-converted anonymous account is swept.';

-- ── 2. "is this a real account?", in SQL ──────────────────────────────────
-- The TS twin is isEstablishedAccount() in src/app/account/lib/accountStatus.ts,
-- and it exists for the same reason: Supabase's is_anonymous flag cannot answer
-- the question on its own. An account whose only identity is an EVE SSO
-- character stays is_anonymous = true forever (EVE SSO is not a Supabase
-- identity — it writes a registration row), so the predicate is "Supabase
-- considers it permanent, OR it owns a character".
--
-- Invoker rights on purpose: the registration probe runs as the caller and its
-- policy is keyed to auth.uid(), so this can only ever see the caller's own
-- rows. auth.jwt() is null outside a request, which makes the coalesce read as
-- "not anonymous" — correct for the service role, which bypasses RLS anyway.
create or replace function public.is_established_account()
returns boolean
language sql
stable
as $$
  select
    coalesce((select (auth.jwt() ->> 'is_anonymous')::boolean), false) is not true
    or exists (select 1 from public.registration r where r.user_id = (select auth.uid()));
$$;

grant execute on function public.is_established_account() to authenticated;

-- The three tables that were readable by "any signed-in user" — a phrase that
-- silently grew to include every drive-by visitor the moment anonymous
-- sign-ins were switched on. They hold resolved names for ids the extracts have
-- surfaced (universe_name), character→corp affiliations (character_affiliation)
-- and the player-structure cache (universe_structure): nothing catastrophic,
-- but nothing a visitor who has not brought a character has any use for either.
--
-- Everything else survived the audit unchanged:
--   • the per-owner extract tables key on the caller's own registrations, so
--     they are naturally empty for an account that owns nothing;
--   • the share tables' audience matcher already requires overlapping corp or
--     alliance membership — except the deliberately public branch (no secret,
--     no audience lists), which means public, anonymous callers included;
--   • world-readable tables (character_directory, corporation, alliance,
--     sde_*, esf_data, sheet_csv, industry_system_index) are already granted to
--     the anon role, so anonymous sign-ins change nothing about them;
--   • write policies all pin created_by/user_id to auth.uid(), and the ones
--     that matter (mercenary_den_enemy_intel) additionally require owning a
--     registration — which is exactly the established test.
drop policy if exists "Authenticated read universe_name" on public.universe_name;
create policy "Established accounts read universe_name"
  on public.universe_name
  for select
  to authenticated
  using ((select public.is_established_account()));

drop policy if exists "Authenticated read character_affiliation" on public.character_affiliation;
create policy "Established accounts read character_affiliation"
  on public.character_affiliation
  for select
  to authenticated
  using ((select public.is_established_account()));

drop policy if exists "Authenticated read universe_structure" on public.universe_structure;
create policy "Established accounts read universe_structure"
  on public.universe_structure
  for select
  to authenticated
  using ((select public.is_established_account()));

-- ── 3. the sweep ──────────────────────────────────────────────────────────
-- Anonymous accounts that never became anything: older than the cutoff, owning
-- no character, no GICE link, and carrying no Supabase identity beyond the
-- anonymous one. The last two conditions are why this can't be a plain
-- is_anonymous filter — see is_established_account() above.
--
-- SECURITY DEFINER because auth.users and auth.identities are not reachable
-- from PostgREST; service-role-only, since the caller then deletes the accounts
-- it names. The blanket default privileges in schema.sql hand every function to
-- anon/authenticated, so the revoke is load-bearing.
create or replace function public.sweepable_anonymous_users(
  older_than interval default interval '30 days',
  max_rows integer default 500
)
returns setof uuid
language sql
security definer
set search_path = public, auth, pg_temp
as $$
  select u.id
  from auth.users u
  where u.is_anonymous
    and u.created_at < now() - older_than
    and not exists (select 1 from public.registration r where r.user_id = u.id)
    and not exists (select 1 from public.gice_account g where g.user_id = u.id)
    and not exists (select 1 from auth.identities i where i.user_id = u.id and i.provider <> 'anonymous')
  order by u.created_at
  limit max_rows;
$$;

revoke execute on function public.sweepable_anonymous_users(interval, integer) from public, anon, authenticated;
grant   execute on function public.sweepable_anonymous_users(interval, integer) to service_role;
