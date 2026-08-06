-- Phase 7 of the sharing layer's Revision 3 (docs/sharing-layer/07-lens.md):
-- the lens table. A Lens is a saved GraphQL query that runs under the
-- CREATOR's security context when a viewer opens it — the viewer receives
-- results, never access. Shared with the standard Revision 3 audience row
-- (corporation_ids / alliance_ids / secret; fully public = the row that names
-- no one), and user_id-keyed rather than registration-keyed because a Lens
-- spans all the creator's registrations the way their GraphQL context does.
--
-- The audience-read policy exposes the row — including the query text — to
-- the audience: discovery is the point, and the query IS what they may run.
-- The secret rides along like on every share table; harmless by design, since
-- a URL token is an HMAC keyed by secret AND the env-only TOKEN_SALT.
create table public.lens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  query text not null,
  variables jsonb not null default '{}',
  -- Unlike the sibling share tables, the lens row IS the share row — so the
  -- Revision 3 "empty audience = public" reading would make a freshly created
  -- lens public by default. `shared` keeps "not shared yet" (the no-row state
  -- the other tables get for free) distinct from "shared with everyone".
  shared boolean not null default false,
  corporation_ids bigint[] not null default '{}',
  alliance_ids bigint[] not null default '{}',
  secret text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index lens_user_id_idx on public.lens (user_id);

alter table public.lens enable row level security;

-- Owner manages their lenses outright (the shared_asset_token FOR ALL shape —
-- the owner is a user, not a registration, so the predicate is direct).
create policy "Users manage own lenses"
  on public.lens
  for all
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Audience discovery, the load-bearing array/anon policy every Revision 3
-- share table carries. Link-only lenses match no one under RLS — the signed
-- ?share= link is resolved at the app layer.
create policy "Audience reads lenses aimed at them"
  on public.lens
  for select
  to anon, authenticated
  using (shared and public.share_audience_matches(corporation_ids, alliance_ids, secret));

grant select                         on public.lens to anon;
grant select, insert, update, delete on public.lens to authenticated;
grant all                            on public.lens to service_role;
