-- bpo_share — the audience for one account's blueprint-original showcase
-- (/bpos/[main-character-name]).
--
-- The standard Revision 3 audience shape (corporation_ids / alliance_ids /
-- secret, fully public = the row that names no one), but keyed on user_id
-- rather than a registration, like `link` and for the same reason: the subject
-- is "everything this account owns", spanning every character on it. That is a
-- deliberate, owner-initiated exception to the per-character rule the asset and
-- fitting shares keep — the page exists to showcase a collection, and its whole
-- premise is pooling the alts. No row means not shared, so nothing is
-- correlated until the owner asks for it.
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
