-- Re-issue of 20260822120000_bpo_share.sql, which never reached production.
--
-- WHAT HAPPENED. #945 and #946 merged sixteen seconds apart, each carrying a
-- migration stamped 20260822120000 — the two-open-PRs-same-timestamp case the
-- ordering guard cannot see (neither PR's guard run could know about the other,
-- since neither had merged yet). #945's Migrate run applied
-- structure_tax_revenue_split_signs and recorded (20260822120000,
-- structure_tax_revenue_split_signs). #946's run then compared two local files
-- at that one version against the single remote row, matched them BY VERSION in
-- sorted order, and so decided bpo_share -- alphabetically first -- was the one
-- already applied. It never ran. structure_tax_revenue_split_signs was left
-- looking pending, and re-applying it hit the composite primary key:
--
--   ERROR: duplicate key value violates unique constraint "schema_migrations_pkey"
--   Key (version, name)=(20260822120000, structure_tax_revenue_split_signs) already exists.
--
-- The (version, name) key did its job — it stopped a double apply — but the CLI
-- has no way to reconcile the mismatch, so `db push` aborts before reaching
-- anything newer. A one-time repair of supabase_migrations.schema_migrations is
-- needed alongside this file; see docs/bpo-share-collision.md.
--
-- WHY A NEW FILE. 20260822120000_bpo_share.sql cannot be renamed or deleted: a
-- migration's filename is its identity to every database that applied it, and
-- the ordering guard enforces that. The documented remedy for a wrong version is
-- a NEW migration with a fresh timestamp, which is what this is.
--
-- Idempotent throughout, so it is a no-op against any environment where the
-- original did land (the ephemeral branch CI provisions for `test:branch`).

-- ── bpo_share ──────────────────────────────────────────────────────────────
-- The audience for one account's blueprint-original showcase, the public page
-- at /bpos/[main-character-name]. Standard Revision 3 audience row
-- (corporation_ids / alliance_ids / secret; fully public = the row that names
-- no one), and user_id-keyed rather than registration-keyed for the same reason
-- `link` is: the subject is "every original this account owns", pooled across
-- every character on it.
--
-- That pooling is a deliberate exception to the per-character grantor rule the
-- asset and fitting shares keep (docs/sharing-layer/design.md's alt-privacy
-- invariant). It is owner-initiated and opt-in — no row means not shared, the
-- page 404s, and nothing about the account's alts is correlated for anyone.
create table if not exists public.bpo_share (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  corporation_ids bigint[] not null default '{}',
  alliance_ids bigint[] not null default '{}',
  secret text,
  created_at timestamptz not null default now()
);

alter table public.bpo_share enable row level security;

-- Owner manages their own row outright (the `link` shape — the owner is a user,
-- so the predicate is direct rather than a registration subquery).
drop policy if exists "Users manage own bpo share" on public.bpo_share;
create policy "Users manage own bpo share"
  on public.bpo_share
  for all
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Audience discovery, the load-bearing array policy every Revision 3 share
-- table carries: the page asks this table, as the viewer, whether a share is
-- aimed at them. Link-only rows match nobody here — a URL token is invisible to
-- the database, so signed links resolve at the app layer (src/shareToken.ts) —
-- and so does the fully-public row for a signed-out visitor, whom the page
-- clears through the service role instead.
drop policy if exists "Audience reads bpo shares aimed at them" on public.bpo_share;
create policy "Audience reads bpo shares aimed at them"
  on public.bpo_share
  for select
  to anon, authenticated
  using (public.share_audience_matches(corporation_ids, alliance_ids, secret));

grant select                         on public.bpo_share to anon;
grant select, insert, update, delete on public.bpo_share to authenticated;
grant all                            on public.bpo_share to service_role;
