# Sharing layer: unified, recursive asset shares (Revision 3)

Make asset paths shareable — a container, a ship, or any asset — with the share
applying **recursively** to everything inside it, and the audience configurable
per share: a list of corporations, a list of alliances, a signed link token, or
fully public. The data structure and RLS shape follow the pattern that already
works for mercenary dens and fittings: a `_share` sibling table plus additional
**SELECT policies** that widen what the audience can read — never a parallel
read path, never a copy of the data. Later phases fold the fitting and
mercenary-den share mechanisms into the same model, and add **Lenses**: shared
GraphQL queries that run under the _creator's_ security context and render to
CSV, superseding the `api_token` Google Sheets endpoints.

Each numbered doc below is a self-contained implementation spec; do them as
**separate PRs, in order**. `design.md` in this directory is Revision 2 of the
model — still the right read for the identity split, the alt-privacy
rationale, and the invariants — but where this README and the phase docs
diverge from it (audience representation, token scheme), **Revision 3 wins**.

## Why

Three-and-a-half sharing mechanisms exist today, each with a different model:

| Mechanism              | Table                           | Audience model                                    | Recursive?       | Anonymous?              |
| ---------------------- | ------------------------------- | ------------------------------------------------- | ---------------- | ----------------------- |
| Mercenary dens         | `character_mercenary_den_share` | one row per (registration, alliance)              | n/a              | no                      |
| Fittings               | `character_fitting_share`       | one row per level (`corporation/alliance/public`) | n/a              | no (`token` col unused) |
| Ship/asset share links | `shared_asset_token`            | secret URL token, resolved via service role       | one level, in JS | yes                     |
| (structures)           | hard-coded alliance policy      | —                                                 | n/a              | no                      |

Dens and fittings are on the target _RLS_ shape (share row + widening policy,
invoker rights, `character_directory` for owner affiliation) but disagree on
audience representation. The asset token path bypasses RLS entirely: the
`/asset/[locationId]` and `/ship/[itemId]` pages re-implement scoping in JS on
the service client, can't use the recursive `*_location_contents` RPCs (which
are SECURITY INVOKER), and only cover the exact id in the URL. This project
replaces that with one model that RLS enforces everywhere — pages, MCP tools,
and GraphQL inherit shared visibility automatically because they all query as
the caller.

## Target model

One share row per shared thing, on a `_share` sibling table. Audience is
carried **on the row** (not one row per audience):

- **(a) corporations** — `corporation_ids bigint[]`: a viewer with a
  registration in any listed corporation sees the rows.
- **(b) alliances** — `alliance_ids bigint[]`: same, matched against the
  viewer's alliances (via `my_alliance_ids()`).
- **(c) link token** — `secret` (random bytes) stored on the row; the URL
  token is an HMAC **signature** derived from the secret and the `TOKEN_SALT`
  environment variable (set on Vercel). A database dump alone cannot mint a
  valid link — the salt lives only in the environment. Resolved at the app
  layer (an anonymous HTTP request is invisible to RLS).
- **(d) fully public** — `secret is null and corporation_ids = '{}' and
alliance_ids = '{}'`. A public share is represented as a share that names
  no one: the empty audience _is_ the "everyone" audience.

For assets the share subject is an `item_id`, and visibility is **recursive**:
a share on a ship or container covers every item inside it, to any depth,
following the same parentage walk `asset_ancestors()` /
`character_asset_location_contents()` already do.

Exposure is always the **current view** (`is_current` rows) — shares never
open SCD-2 history, and GraphQL never exposes the `_over_time` tables, shared
or not.

## Risk model

The ordering runs safest-first:

1. Pure additive schema (share table + helpers) with nothing reading it yet.
2. The widening policies — the risky part is the **recursive** check under
   RLS (a policy whose helper reads the same table recurses; see phase 02 for
   the one sanctioned SECURITY DEFINER boolean that breaks the cycle).
3. UI on top of a proven substrate.
4. Read-side surfaces (GraphQL) that only consume what RLS already grants.
5. Migrations of working mechanisms (fittings, dens) last — they have users.
6. Lens, which builds on both the share model and the GraphQL API.

## The plan

| Doc                                                              | What                                                                                                                                              | Status / dependency           |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| [01-asset-share-table.md](01-asset-share-table.md)               | `character_asset_share` table, owner + audience policies, `asset_share_matches_caller()`, `TOKEN_SALT` + token signing seam                       | not started                   |
| [02-recursive-rls.md](02-recursive-rls.md)                       | Recursive widening policy on `character_asset_over_time` via the definer boolean `asset_share_covers()`; grantee RPC access                       | after 01                      |
| [03-share-dialog.md](03-share-dialog.md)                         | Share button + `<dialog>` on `/asset/[locationId]` and `/ship/[itemId]`; server actions; legacy `shared_asset_token` compat                       | after 02                      |
| [04-graphql-shared.md](04-graphql-shared.md)                     | Shared rows in GraphQL — session mode only, current views only, opt-in                                                                            | after 02                      |
| [05-supersede-fittings.md](05-supersede-fittings.md)             | Fold `character_fitting_share` into the unified audience model, keep the fitting page UI                                                          | after 03                      |
| [06-supersede-mercenary-dens.md](06-supersede-mercenary-dens.md) | Fold `character_mercenary_den_share` into the unified model                                                                                       | after 05                      |
| [07-lens.md](07-lens.md)                                         | Lenses: shared GraphQL queries under the creator's context, CSV rendering to supersede the Sheets endpoints; `/lens` editor behind a feature flag | after 04 (05/06 not required) |

## What already exists (build on this, don't reinvent it)

- `my_corporation_ids()` / `my_alliance_ids()` — invoker-rights membership
  helpers (schema.sql; shipped with den sharing). Every audience match goes
  through these.
- `character_directory` — the world-readable identity table (no `user_id`,
  ever). Owner affiliation for audience checks resolves through it, never
  through `registration`, which is RLS-hidden to non-owners.
- The den share's **load-bearing audience-read policy**: because the
  visibility helpers run as the querying user, the audience can only match
  share rows the share table's own policies expose to them. Every new share
  table repeats this.
- `asset_ancestors()` / `character_asset_location_contents()` /
  `character_asset_subtree_items()` — the depth-capped recursive walks
  (SECURITY INVOKER). Phase 02's recursion is the same shape.
- The fitting share UI (`src/app/fitting/shareControls.tsx` + `actions.ts`)
  and the den picker (`src/app/mercenary-dens/shareAlliance.tsx` +
  `actions.ts`) — working create/revoke server actions on the cookie-session
  client. The share dialog copies their approach, not the service role.
- `src/utils/csv.ts` `toCsv()` and the `/api/*` CSV route shape — what the
  Lens CSV rendering reuses.

## Invariants (unchanged from Revision 2, plus new ones)

- **Read-only grants.** A share never allows the audience to write anything.
- **No SECURITY DEFINER** — with exactly one sanctioned exception, the
  boolean `asset_share_covers()` (phase 02), which exists only to break RLS
  policy recursion, returns a single boolean, and never returns row data.
- **`user_id` is never world-readable**; alt correlation stays impossible.
- **Current rows only.** Widening policies carry `is_current`; shares never
  expose SCD-2 history. GraphQL exposes only the current views — never the
  `_over_time` tables (this holds for every phase, including Lens).
- Shares widen exactly the shared subject; wallets, tokens, settings, and
  unrelated tables are never touched by any policy in this layer.

## Verification (every PR)

- `pnpm run lint`, `pnpm test`, `pnpm run build`.
- Schema changes are **dual-write**: edit `schema.sql` _and_ add a
  `supabase/migrations/` file (never rename an existing migration).
- The two-account leak test, per phase: account B must see exactly what A
  shared and nothing else; revoking must close access on the next request.
- `pnpm run test:sql` gains assertions per phase where the logic is in
  Postgres (the recursion helper especially) — point `DATABASE_URL` at a
  throwaway database.

## House rules (from CLAUDE.md — these bite)

- `git fetch origin && git rebase origin/main` immediately before every push.
- Never rename an existing file under `supabase/migrations/`.
- ramda over `for`/`while`; tail recursion for unbounded pagination.
- Prefer distinct migration timestamps; the composite key is a backstop.
