-- ── corp_bpo_share ────────────────────────────────────────────────────────
-- The audience for one CORPORATION's blueprint-original showcase, the page at
-- /bpos/[corporation-name]. Blueprints deposited into a corp hangar belong to
-- the corporation, so they land in corp_blueprint and never appear on the
-- account-scoped showcase; this is that collection's share row.
--
-- Standard Revision 3 audience shape (corporation_ids / alliance_ids / secret;
-- fully public = the row that names no one), keyed one row per corporation the
-- way bpo_share is keyed one row per account.
--
-- WHO MAY MANAGE IT. Any account with a character in the corporation — which is
-- exactly the set that can already read corp_blueprint for it, so nobody can
-- share data they cannot themselves see. In-game roles are not tracked
-- anywhere in this deployment (a Director token proves a scope was granted, not
-- that the holder is a Director), and gating on the token holder would break
-- the common case of an alt carrying the scope while the main runs the page.
-- The share dialog says as much: any member can change or revoke it.
create table if not exists public.corp_bpo_share (
  id uuid primary key default gen_random_uuid(),
  corporation_id bigint not null unique,
  corporation_ids bigint[] not null default '{}',
  alliance_ids bigint[] not null default '{}',
  secret text,
  -- Audit only: who first published it. Never read for authorization — a
  -- member who leaves must not keep control, and one who joins must not be
  -- locked out.
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.corp_bpo_share enable row level security;

-- Members of the corporation manage its row. The subquery is the same
-- membership test corp_blueprint_over_time's own read policy uses.
drop policy if exists "Members manage corp bpo share" on public.corp_bpo_share;
create policy "Members manage corp bpo share"
  on public.corp_bpo_share
  for all
  to authenticated
  using (
    corporation_id in (
      select corporation_id from public.registration
      where user_id = (select auth.uid()) and corporation_id is not null
    )
  )
  with check (
    corporation_id in (
      select corporation_id from public.registration
      where user_id = (select auth.uid()) and corporation_id is not null
    )
  );

-- Audience discovery, the load-bearing array policy every Revision 3 share
-- table carries: the page asks this table, as the viewer, whether a share is
-- aimed at them. Link-only rows match nobody here (RLS cannot see a URL token;
-- signed links resolve at the app layer), and neither does the fully-public row
-- for a signed-out visitor -- the page clears that case through the service
-- role rather than leaning on an anon evaluation of my_corporation_ids().
drop policy if exists "Audience reads corp bpo shares aimed at them" on public.corp_bpo_share;
create policy "Audience reads corp bpo shares aimed at them"
  on public.corp_bpo_share
  for select
  to anon, authenticated
  using (public.share_audience_matches(corporation_ids, alliance_ids, secret));

grant select                         on public.corp_bpo_share to anon;
grant select, insert, update, delete on public.corp_bpo_share to authenticated;
grant all                            on public.corp_bpo_share to service_role;
