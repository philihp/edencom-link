-- Phase 14, PR 2 of the sharing layer (docs/sharing-layer/14-corp-asset-share.md):
-- the corp asset share table, with the Revision 3 audience shape every other
-- share in this layer carries. Purely additive — nothing reads it yet (the
-- recursive widening policy on corp_asset_version is PR 3, the dialog PR 4).
--
-- The twin of character_asset_share, with the one difference the subject
-- forces: the grantor is the CORPORATION, not a registration. A share belongs
-- to the corp rather than to whoever clicked, so it outlives its author's
-- membership and any member can change or stop it — the way the corp's extract
-- keeps running on the next director's token.
create table public.corp_asset_share (
  id uuid primary key default gen_random_uuid(),
  -- Grantor: the corporation holding the shared item.
  corporation_id bigint not null,
  -- Audit: the registration that created the row. Nullable and `on delete set
  -- null` rather than cascade — a member's account closing must not silently
  -- end the corporation's share. The insert policy below forces a real one of
  -- the caller's own registrations at creation; nothing ever displays it, and
  -- it is deliberately a registration and never a user_id, so it stays
  -- unreadable outside the owning account.
  created_by uuid references public.registration(id) on delete set null,
  -- Subject: the shared item (an office, container, ship, any corp asset). The
  -- share covers this item and, recursively, everything inside it (PR 3).
  item_id bigint not null,
  corporation_ids bigint[] not null default '{}',
  alliance_ids bigint[] not null default '{}',
  secret text,
  created_at timestamptz not null default now(),
  unique (corporation_id, item_id)
);
create index corp_asset_share_item_id_idx on public.corp_asset_share (item_id);

alter table public.corp_asset_share enable row level security;

-- Owner-side policies. The grant predicate is the read predicate the corp
-- hangar already carries (`corporation_id in my_corporation_ids()`): whoever
-- can see the item can share it, edit the share, or stop it. with check
-- repeats it so a row can't be re-pointed at another corporation.
create policy "Members read own corp asset shares"
  on public.corp_asset_share
  for select
  to authenticated
  using (corporation_id in (select public.my_corporation_ids()));

-- Creation additionally pins the audit column to one of the caller's own
-- characters, so `created_by` can only ever name a registration of the account
-- that minted the row.
create policy "Members create own corp asset shares"
  on public.corp_asset_share
  for insert
  to authenticated
  with check (
    corporation_id in (select public.my_corporation_ids())
    and created_by in (select id from public.registration where user_id = (select auth.uid()))
  );

create policy "Members update own corp asset shares"
  on public.corp_asset_share
  for update
  to authenticated
  using (corporation_id in (select public.my_corporation_ids()))
  with check (corporation_id in (select public.my_corporation_ids()));

create policy "Members remove own corp asset shares"
  on public.corp_asset_share
  for delete
  to authenticated
  using (corporation_id in (select public.my_corporation_ids()));

-- The audience-read policy is LOAD-BEARING, exactly as on character_asset_share:
-- PR 3's visibility check runs as the querying user, so it can only match share
-- rows this policy exposes to them. `to anon` because a fully-public share is
-- visible signed-out. A matched audience member reads the whole row including
-- `secret` — harmless by design: a URL token is an HMAC over the share id keyed
-- by secret AND the env-only TOKEN_SALT, so a leaked secret still can't mint a
-- valid link.
create policy "Audience reads corp asset shares aimed at them"
  on public.corp_asset_share
  for select
  to anon, authenticated
  using (public.share_audience_matches(corporation_ids, alliance_ids, secret));

grant select                         on public.corp_asset_share to anon;
grant select, insert, update, delete on public.corp_asset_share to authenticated;
grant all                            on public.corp_asset_share to service_role;
