# Phase 1: the `character_asset_share` table

**Status: not started.**

Pure additive schema: the share table, its owner and audience policies, the
audience-match helper, and the token-signing seam. Nothing reads it yet — the
widening policy on the asset tables is phase 2, the UI phase 3 — so this PR
has zero blast radius on existing behavior.

## The table

One row per shared thing. Audience lives **on the row** as arrays, not one
row per audience (this supersedes design.md Revision 2's `audience` enum and
the fitting share's `level` rows):

```sql
create table public.character_asset_share (
  id uuid primary key default gen_random_uuid(),
  -- Grantor: the registration owning the shared item. Per-character, never
  -- user_id (the alt-privacy invariant; see design.md).
  registration_id uuid not null references public.registration(id) on delete cascade,
  -- Subject: the shared item (a ship, container, or any asset). The share
  -- covers this item and, recursively, everything inside it (phase 2).
  item_id bigint not null,
  -- (a) Viewers with a registration in any of these corporations see the rows.
  corporation_ids bigint[] not null default '{}',
  -- (b) Same, matched against the viewer's alliances.
  alliance_ids bigint[] not null default '{}',
  -- (c) Link-token mode: a random private key (32 bytes, hex). The URL token
  -- is an HMAC signature derived from this and TOKEN_SALT — see below. Null
  -- when the share has no link.
  secret text,
  created_at timestamptz not null default now(),
  unique (registration_id, item_id)
);
create index character_asset_share_item_id_idx on public.character_asset_share (item_id);

alter table public.character_asset_share enable row level security;
```

**(d) Fully public** is the row state `secret is null and corporation_ids =
'{}' and alliance_ids = '{}'` — a public share is represented as a share
that names no one. There is no `is_public` flag to drift out of sync.

The audiences compose: a row may carry corporation ids _and_ a secret; each
grant path is independent.

## Policies

Owner policies mirror `character_mercenary_den_share` exactly (read own,
insert own, delete own, keyed on `registration_id in (select id from
registration where user_id = (select auth.uid()))`), **plus update** — unlike
the den/fitting tables, audience arrays are edited in place rather than
add/remove rows, so the owner needs `for update` with the same predicate on
both `using` and `with check` (so a row can't be re-pointed at someone else's
registration).

The audience-read policy is **load-bearing** (same reasoning as the den
share: the visibility helper runs as the querying user, so it can only match
share rows these policies expose):

```sql
create policy "Audience reads asset shares aimed at them"
  on public.character_asset_share
  for select
  to anon, authenticated
  using (public.asset_share_matches_caller(corporation_ids, alliance_ids, secret));
```

`to anon` matters: fully-public shares are visible to signed-out viewers, so
`grant select on public.character_asset_share to anon` as well (plus the
usual `select, insert, update, delete` to `authenticated`, `all` to
`service_role`).

## The audience-match helper

Invoker rights, like every helper in this layer:

```sql
create or replace function public.asset_share_matches_caller(
  corporation_ids bigint[], alliance_ids bigint[], secret text
)
returns boolean
language sql
stable
as $$
  select
    -- (d) public: names no one, visible to everyone
    (secret is null and corporation_ids = '{}' and alliance_ids = '{}')
    -- (a)/(b) membership: array overlap with the caller's affiliations
    or corporation_ids && array(select public.my_corporation_ids())
    or alliance_ids && array(select public.my_alliance_ids());
$$;
```

Note what this deliberately does **not** match: a row whose only grant is a
`secret`. RLS cannot see a URL token — link shares are resolved at the app
layer (phase 3) — so to RLS a link-only share is invisible to everyone but
its owner. That is exactly the (c) semantics.

`my_corporation_ids()`/`my_alliance_ids()` already exist (den sharing) and
return empty sets for `anon` (their `registration` read comes back empty), so
the anon path falls through to the public clause only.

## Token signing — `src/shareToken.ts` + `TOKEN_SALT`

New env var `TOKEN_SALT` (add to `.env.example` and Vercel). The URL token
for a link share is a **signature, not the stored secret**:

```ts
// src/shareToken.ts
import { createHmac, timingSafeEqual } from 'node:crypto'

// token = HMAC-SHA256(key = secret ‖ TOKEN_SALT, message = shareId), base64url.
// The DB row alone can't produce a valid link — the salt only exists in the
// environment — and the URL alone can't be looked up backwards to a row.
export const signShare = (shareId: string, secret: string): string => ...
export const verifyShareToken = (shareId: string, secret: string, token: string): boolean => ...
```

The share URL carries `?share=<shareId>.<signature>`: the id locates the row
(service-role lookup, phase 3), the signature proves possession. Verification
recomputes and compares with `timingSafeEqual`. Revoking a link = nulling
`secret` (or rotating it, which invalidates old URLs); deleting the row
revokes everything.

`signShare`/`verifyShareToken` are pure given their inputs — unit-test them in
`test/shareToken.test.ts` with a fixed salt injected as a parameter (read
`process.env.TOKEN_SALT` only at the callers, so the node test runner needs
no env plumbing).

## Deliverables

- Migration `supabase/migrations/<ts>_character_asset_share.sql` + the same
  DDL in `schema.sql` (dual-write).
- `src/shareToken.ts` + `test/shareToken.test.ts`.
- `TOKEN_SALT` in `.env.example`; set it on Vercel before phase 3 ships.
- `pnpm run test:sql` assertions for `asset_share_matches_caller` (public row
  matches with no membership; corp/alliance overlap matches; link-only row
  matches no one).

## Verification

`pnpm run lint && pnpm test && pnpm run build`; `supabase db push` applies
cleanly; a hand-inserted share row is readable by a second account only when
its affiliation overlaps, and by anon only when the row is fully public.
