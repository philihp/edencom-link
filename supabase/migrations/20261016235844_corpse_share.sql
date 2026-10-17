-- ── corpse_share ───────────────────────────────────────────────────────────
-- The audience for one account's frozen-corpse collection, the page at
-- /corpses/[main-character-id]. Standard Revision 3 audience row
-- (corporation_ids / alliance_ids / secret; fully public = the row that names
-- no one), user_id-keyed exactly like `bpo_share`: the subject is every corpse
-- the account holds, pooled across its characters.
--
-- WHY THIS EXISTS. The page shipped with no share row at all. It resolved the
-- character id in the URL to its account, listed every character's corpses and
-- titled itself with the account's MAIN — so an anonymous visitor holding an
-- ALT's id read back the main's name, and two ids rendering the same page
-- proved one owner. That is precisely the correlation character_directory
-- carries no user_id to prevent. The page's own comment claimed an opt-in flag
-- gated it; that mechanism was retired with src/flags.ts and nothing replaced
-- it, so the gate had not existed for some time. No row means not shared, and
-- the page 404s.
--
-- The pooling across an account's characters is the same deliberate exception
-- to the per-character grantor rule that bpo_share makes, and safe for the same
-- reason: it is owner-initiated, and nothing is correlated until the owner asks
-- for it. The page is addressed by the MAIN's character id, so an alt's id
-- never resolves even where the account does share.
create table if not exists public.corpse_share (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  corporation_ids bigint[] not null default '{}',
  alliance_ids bigint[] not null default '{}',
  secret text,
  created_at timestamptz not null default now()
);

alter table public.corpse_share enable row level security;

-- Owner manages their own row outright (the `bpo_share`/`link` shape — the
-- owner is a user, so the predicate is direct rather than a registration
-- subquery).
drop policy if exists "Users manage own corpse share" on public.corpse_share;
create policy "Users manage own corpse share"
  on public.corpse_share
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
drop policy if exists "Audience reads corpse shares aimed at them" on public.corpse_share;
create policy "Audience reads corpse shares aimed at them"
  on public.corpse_share
  for select
  to anon, authenticated
  using (public.share_audience_matches(corporation_ids, alliance_ids, secret));

grant select                         on public.corpse_share to anon;
grant select, insert, update, delete on public.corpse_share to authenticated;
grant all                            on public.corpse_share to service_role;
