-- Phase 1 of the sharing layer's Revision 3 (docs/sharing-layer/01-asset-share-table.md):
-- the asset share table, its owner and audience policies, and the audience-match
-- helper. Purely additive — nothing reads it yet (the widening policy on the
-- asset tables is phase 2, the share dialog phase 3).
--
-- One row per shared thing, with the audience carried ON the row rather than
-- one row per audience (this is what supersedes the fitting share's per-level
-- rows and design.md Revision 2's audience enum):
--   (a) corporation_ids — a viewer with a registration in any listed corp sees
--       the rows the share opens;
--   (b) alliance_ids — same, matched against the viewer's alliances;
--   (c) secret — link-token mode: a random private key; the URL token is an
--       HMAC signature over the share id keyed by this secret and the
--       TOKEN_SALT env var (src/shareToken.ts), resolved at the app layer
--       because RLS cannot see a URL;
--   (d) fully public — secret null and both lists empty: a public share is
--       represented as a share that names no one.
create table public.character_asset_share (
  id uuid primary key default gen_random_uuid(),
  -- Grantor: the registration owning the shared item. Per-character, never
  -- user_id (the alt-privacy invariant; see docs/sharing-layer/design.md).
  registration_id uuid not null references public.registration(id) on delete cascade,
  -- Subject: the shared item (a ship, container, or any asset). The share
  -- covers this item and, recursively, everything inside it (phase 2).
  item_id bigint not null,
  corporation_ids bigint[] not null default '{}',
  alliance_ids bigint[] not null default '{}',
  secret text,
  created_at timestamptz not null default now(),
  unique (registration_id, item_id)
);
create index character_asset_share_item_id_idx on public.character_asset_share (item_id);

alter table public.character_asset_share enable row level security;

-- Whether a share row's audience covers the caller. Invoker rights, like every
-- helper in this layer: my_corporation_ids()/my_alliance_ids() resolve the
-- CALLER's affiliations (empty for anon, whose registration read returns
-- nothing — so anon falls through to the public clause only).
--
-- Deliberately does NOT match a row whose only grant is a secret: RLS cannot
-- see a URL token, so to RLS a link-only share is invisible to everyone but
-- its owner. The signed-link path is resolved at the app layer (phase 3).
create or replace function public.asset_share_matches_caller(
  corporation_ids bigint[], alliance_ids bigint[], secret text
)
returns boolean
language sql
stable
as $$
  select
    (secret is null and corporation_ids = '{}' and alliance_ids = '{}')
    or corporation_ids && array(select public.my_corporation_ids())
    or alliance_ids && array(select public.my_alliance_ids());
$$;

grant execute on function public.asset_share_matches_caller(bigint[], bigint[], text) to anon, authenticated;

-- Owner policies mirror character_mercenary_den_share, PLUS update: audience
-- arrays are edited in place on the one row per item, rather than by
-- adding/removing per-audience rows. with check repeats the predicate so a row
-- can't be re-pointed at someone else's registration.
create policy "Users read own asset shares"
  on public.character_asset_share
  for select
  to authenticated
  using (
    registration_id in (select id from public.registration where user_id = (select auth.uid()))
  );

create policy "Users create own asset shares"
  on public.character_asset_share
  for insert
  to authenticated
  with check (
    registration_id in (select id from public.registration where user_id = (select auth.uid()))
  );

create policy "Users update own asset shares"
  on public.character_asset_share
  for update
  to authenticated
  using (
    registration_id in (select id from public.registration where user_id = (select auth.uid()))
  )
  with check (
    registration_id in (select id from public.registration where user_id = (select auth.uid()))
  );

create policy "Users remove own asset shares"
  on public.character_asset_share
  for delete
  to authenticated
  using (
    registration_id in (select id from public.registration where user_id = (select auth.uid()))
  );

-- The audience-read policy is LOAD-BEARING (same reasoning as the den share):
-- phase 2's visibility check runs as the querying user, so it can only match
-- share rows this policy exposes to them. `to anon` because a fully-public
-- share is visible to signed-out viewers. RLS is row-level, so a matched
-- audience member can read the whole row including `secret` — harmless by
-- design: a URL token is an HMAC over the share id keyed by secret AND the
-- env-only TOKEN_SALT, so a leaked secret (like a leaked DB dump) still can't
-- mint a valid link.
create policy "Audience reads asset shares aimed at them"
  on public.character_asset_share
  for select
  to anon, authenticated
  using (public.asset_share_matches_caller(corporation_ids, alliance_ids, secret));

grant select                         on public.character_asset_share to anon;
grant select, insert, update, delete on public.character_asset_share to authenticated;
grant all                            on public.character_asset_share to service_role;
