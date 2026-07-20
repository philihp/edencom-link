# Sharing layer — data architecture

Design for a uniform, table-driven sharing layer: for every core table a
sibling `<table>_share` table, and RLS of the shape **"read your own rows, or
rows a matching share row grants you."** Replaces the three ad-hoc mechanisms
live today, in stages (identity split → dens → structures → assets → filters).

**Revision 2.** The first cut keyed shares to the account (`user_id`) and
bridged cross-account visibility checks with SECURITY DEFINER functions. Both
are gone: shares are now keyed **per character**, the character→corp→alliance
directory becomes **public**, and the whole layer is expressible in plain
(invoker-rights) RLS. See "Alt privacy" below for why, including the rejected
alternatives (public `user_id`, bloom filters).

## Current state (what this replaces)

| Data | Mechanism today | Shape |
|---|---|---|
| Mercenary dens | `character_mercenary_den_share` | All-or-nothing per (character → corporation); no per-den rows, no alliance audience. Also gates `mercenary_den_enemy_intel` visibility, via the `user_shares_dens_with_caller` / `mercenary_den_owner_names` SECURITY DEFINER helpers (to be deleted). |
| Structures | Hard-coded RLS policy on `corp_structure` | Alliance-mates read the core table unconditionally (dynamic via `corporation.alliance_id`); no opt-out. Fuel already split into `corp_structure_status` (own-corp only). |
| Assets | `shared_asset_token` | Public per-item token links, resolved server-side via the service role; no anon RLS. |

## Identity split: public directory vs. private binding

Today `registration` conflates two things with very different sensitivity:

- **Public EVE identity** — character id, name, corporation. All of this is
  public information in EVE (ESI serves it unauthenticated); hiding it behind
  owner-only RLS is what forced the SECURITY DEFINER workarounds.
- **The account binding** — which `user_id` a character belongs to, `is_main`.
  This is the app's *only* real secret about identity: it maps alts to each
  other. It must never be readable across accounts.

The split:

- **`character`** — world-readable directory (like `corporation`/`alliance`):
  `character_id` (bigint PK), `name`, `corporation_id`, `alliance_id`,
  `registration_id` (nullable unique FK → `registration.id`, `on delete set
  null`), `updated_at`. **No `user_id` — ever.** `registration_id` is included
  so rows in extract tables (which key owners by registration uuid) can be
  joined to a public name/corp/alliance without touching `registration`;
  exposing the uuid↔character mapping leaks nothing, because the uuid already
  appears on any row shared to a viewer and maps to exactly one public
  character. Populated by the character-directory extract job (below).
- **`registration`** — unchanged shape, stays strictly owner-only: the
  account↔character binding. `token` (login tokens + scopes) already hangs off
  it with service-role-only access and is untouched.

**Invariant: no SECURITY DEFINER anywhere in the sharing layer.** Every
visibility rule must be expressible as plain invoker-rights RLS over (a) the
viewer's own registrations, (b) the public directories
(`character`/`corporation`/`alliance`), and (c) the `_share` tables' own
policies. If a rule can't be written that way, the data model is wrong — fix
the model, don't add a definer bridge.

## Core model

Every share row answers three questions:

- **Grantor** — who is sharing. For character-owned data this is the **owning
  character** (`registration.id` uuid, matching the extract tables' owner
  columns). For corp-owned data it's the **corporation** (`corporation_id`),
  with a `created_by` user for audit.
- **Subject** — what is shared. A per-table object id (`den_id`,
  `structure_id`, `item_id`), **nullable = wildcard** ("all of this
  character's rows in this table").
- **Audience** — who may see it. Four kinds:

| `audience` | Target column | Resolution |
|---|---|---|
| `corporation` | `audience_corporation_id` | Static: viewer has a registration in that corp. |
| `alliance` | `audience_corporation_id` | **Dynamic**: resolved at query time to that corp's *current* alliance via `corporation.alliance_id`. If the corp changes alliance, the share follows (lag = directory refresh cadence; accepted). Stored as a corp, never as an alliance id. |
| `public` | — | True anon RLS: the underlying rows become selectable through the anon key. Enumerable by design. |
| `link` | `token` | Unguessable token (16 random bytes hex, like `shared_asset_token`). **Not expressed in RLS at all** — resolved server-side via the service role, which then scopes queries to the grantor's rows (today's `/ship/[itemId]?token=` pattern, generalized). |

`public` and `link` are distinct audiences: `link` means "anyone with the URL,"
`public` means "anyone at all, including direct anon-key queries."

### Ownership validity and orphaned shares

A share is honored only while the granting character still owns the row: the
RLS predicate is a plain equality join (`core.character_id =
share.character_id`, or `core.corporation_id = share.corporation_id`). An item
that moves to a *different* character — including another character on the
same account — orphans the share: the row stays but grants nothing.

Orphans are **surfaced, not resurrected**: the owner reads their own share
rows, so the UI lists shares that no longer match any current row ("this share
points at nothing — re-share from the new character, or delete it"). No
cleanup job, no silent transfer.

### Common `_share` columns

```sql
create table public.<subject>_share (
  id                      uuid primary key default gen_random_uuid(),
  -- grantor (one of the two, per table family):
  character_id            uuid references public.registration(id) on delete cascade,  -- character-owned
  corporation_id          bigint,                                  -- corp-owned (+ created_by uuid for audit)
  -- subject scope (per-table; null = all of the grantor's rows):
  <object_id>             bigint,
  -- audience:
  audience                text not null check (audience in ('corporation','alliance','public','link')),
  audience_corporation_id bigint,        -- required iff audience in ('corporation','alliance')
  token                   text unique,   -- required iff audience = 'link'
  created_at              timestamptz not null default now(),
  expires_at              timestamptz    -- null = never; checked in every policy. No UI yet.
);
```

Check constraints tie `audience` to its target column (`corporation`/`alliance`
⇒ `audience_corporation_id not null and token is null`; `link` ⇒ `token not
null`; `public` ⇒ both null).

### Shared helper functions (reused by every stage; all plain invoker-rights)

```sql
my_corporation_ids() returns setof bigint;  -- corps of the caller's own registrations (RLS-readable)
my_alliance_ids()    returns setof bigint;  -- those corps' alliances, via the public corporation directory
share_audience_matches(audience text, audience_corporation_id bigint) returns boolean;
--  'public'      → true (works for anon too)
--  'corporation' → audience_corporation_id ∈ my_corporation_ids()
--  'alliance'    → corporation.alliance_id of audience_corporation_id ∈ my_alliance_ids()
--  'link'        → false (never granted via RLS)
```

Stable SQL functions, `(select auth.uid())` initplan-friendly. No SECURITY
DEFINER: the caller can read their own registrations, and
`corporation`/`alliance` are world-readable.

### RLS policy pattern

On each core `_over_time` table, an additional **permissive SELECT policy**
OR'd with the existing own-rows policy (policies live on the base tables; the
`is_current` views inherit as today):

```sql
create policy "Shared rows"
  on public.<core>
  for select
  to anon, authenticated          -- anon included so audience='public' works
  using (
    is_current                    -- shares expose current state only, never SCD-2 history
    and exists (
      select 1
      from public.<core>_share s
      where s.character_id = <core>.character_id            -- ownership validity, plain join
        and (s.<object_id> is null or s.<object_id> = <core>.<object_id>)
        and (s.expires_at is null or s.expires_at > now())
        and public.share_audience_matches(s.audience, s.audience_corporation_id)
    )
  );
```

Two consequences to be deliberate about:

- **The `_share` tables need their own read policies** so the `exists`
  subquery (running as the viewer) sees the rows aimed at it: owner gets
  `for all`; everyone else (including anon) gets SELECT on rows where
  `share_audience_matches(...)` is true. `link` rows never match, so tokens
  are never readable by non-owners.
- **`grant select ... to anon`** must be added to any core table that supports
  the `public` audience. The policy still gates every row; the grant just
  stops being an implicit second lock.

Writes to `_share` tables go through plain RLS (grantor-managed for
character-owned data — the owner of the granting registration; Director-gated
for corp-owned), retiring the service-role write path the den share UI uses
today.

### History

Shares expose **current rows only** (`is_current`), never the SCD-2 history.
The owner keeps full history through the own-rows policy. Append-only
observation tables that back a "current" view (den status) get the same share
predicate keyed on the den.

### Alt privacy: why per-character, and the rejected alternatives

The one secret the identity model protects is **which characters share an
account** (alt correlation — in EVE, mapping a spy alt to its owner is exactly
the attack users fear). Three designs were considered:

1. **User-keyed shares + public `user_id`** (rejected): shares would survive
   items moving between a user's own alts, but a public
   character→user mapping lets anyone ask "do X and Y share an owner?" —
   alt correlation for free.
2. **User-keyed shares + SECURITY DEFINER bridges** (rejected; briefly
   implemented): keeps `user_id` private and answers only "is this row shared
   to me?" through privileged boolean functions. Works, but every future stage
   needs its own definer function, each one a privilege-escalation surface to
   audit forever. The complexity exists only to preserve share-follows-alt.
3. **Bloom filter over each account's character set** (investigated,
   rejected): publish a structure anyone can *check* ("is X in this set?") but
   not *enumerate*. Fails on three counts. (a) EVE character ids are a small,
   public, enumerable space (~tens of millions, listable via ESI) — an
   offline-checkable digest over a small input space is recoverable by brute
   force in seconds, the same reason hashed phone numbers are still PII.
   (b) The *targeted* query is the actual attack: "is this suspected alt in
   Bob's set?" is one membership check, which any publicly checkable structure
   answers by construction — full-set recovery is irrelevant. (c) False
   positives can't save it: tuned high enough to bury bulk enumeration
   (~1% FP over 30M candidates ≈ 300k phantoms), a targeted hit still carries
   a ~100:1 likelihood ratio, and if the filter feeds access control every
   false positive grants a stranger visibility. Keying the hashes with a
   server-held secret blocks offline checking but turns the filter back into
   an online privileged oracle — a SECURITY DEFINER function with extra
   steps. Structures like this can't beat "offline-checkable = enumerable;
   not offline-checkable = you've rebuilt the bridge."

Hence **per-character shares**: nobody ever needs to resolve an account's
character set, so there is nothing to hide and nothing to bridge. The cost is
that a share dies when its object changes hands — surfaced to the owner as an
orphan (above). If users ever *want* their alts correlatable to a chosen
audience, that's just another sharable object: an `account_share` row exposing
the alt mapping itself, opt-in, same audience model — not an oracle.

## Per-table design

### Stage A — identity split + character directory extract

New `character` directory table (shape above) + the extract job that populates
it. See the PR plan for job details. `registration` keeps its current shape
and policies; nothing moves off it in this stage except *reads* that only
needed public identity.

### Stage B — Mercenary dens

New-shape `character_mercenary_den_share` (replacing the current table
in place):

```sql
character_id  uuid not null references registration(id) on delete cascade,  -- grantor: the den-owning character
den_id        bigint,                    -- scope: one den (null = all of this character's dens). Per-den supported; no UI yet.
audience / audience_corporation_id / token / created_at / expires_at
```

- **Migration is 1:1**: today's rows are already per (character, corp) — each
  becomes `(character_id, den_id = null, audience = 'corporation',
  audience_corporation_id = corporation_id)`.
- **Policies rewritten** as plain joins (pattern above) on
  `character_mercenary_den_over_time` and `character_mercenary_den_status`.
- **Delete the definer helpers** `mercenary_den_owner_names` and
  `user_shares_dens_with_caller` (from migration `20260720050000`): shared-den
  owner names now come from the public `character` directory
  (`character.registration_id = den.character_id`), and intel visibility is
  re-keyed (next point).
- **Enemy intel re-keyed per character**: `mercenary_den_enemy_intel` gains
  `reporter_id uuid references registration(id) on delete set null`; new
  reports set it to the submitting user's main registration (the UI already
  attributes reports to that character's name), and visibility becomes "a
  share row of `reporter_id` matches the viewer" — a plain join. Backfill:
  match `created_by`'s registration whose `name = reported_by`, else that
  user's main; rows left null stay visible to their submitter only.
  `created_by` stays for self-visibility and write policies.
- **UI** (`shareCorps.tsx`): per-character grantor means the picker persists
  one row per (registered character × chosen target). Targets: each of the
  caller's corporations, plus (new) each corp's **alliance**. Orphaned shares
  (grantor character no longer owns any matching den) listed with a delete
  affordance.

### Stage C — `character-roles` extract

Director prerequisite for corp-owned shares: ESI
`GET /characters/{id}/roles/` (scope `esi-characters.read_corporation_roles.v1`),
standard per-character job, table `character_role (character_id uuid pk
references registration(id) on delete cascade, roles text[], recorded_at)`,
plus a plain (invoker) `is_director(corp_id)` helper — the caller reads their
*own* registrations and roles, so no definer needed. Ships independently of
any sharing behavior: scope opt-in on `/account/settings`, freshness row on
`/character/refresh`.

### Stage D — Structures

`corp_structure_share`: grantor `corporation_id` (+ `created_by`), subject
`structure_id` (null = all corp structures), same audience columns.

- **Seeded default**: migration inserts `(corporation_id, structure_id = null,
  audience = 'alliance', audience_corporation_id = corporation_id)` for every
  corp already in `corp_structure`, then the hard-coded "Alliance members read
  corp structures" policy is dropped and replaced by the share-driven one —
  behavior identical at cutover, but now visible and revocable.
- **Seed-once**: `corporation.structure_share_seeded_at timestamptz`; the
  `corp-structures` extract seeds the default row only when null, then stamps
  it — a Director deleting the row (opting out) is never re-seeded.
- **Fuel and rigs stay private**: `corp_structure_status` (fuel timer) and
  `corp_structure_rig` keep their own-corp-only policies; shares never widen
  them.
- **Writes**: `is_director(corporation_id)` RLS on the share table.
  `/structure` gains a Directors-only control to toggle the alliance default.

### Stage E — Character assets

`character_asset_share`: grantor `character_id` (registration uuid — matches
`character_asset_over_time.character_id` directly), subject `item_id` (null =
this character's whole hangar), `include_contents boolean not null default
true` (sharing a container/ship shares what's inside it, recursively),
audience columns.

- **Migration from `shared_asset_token`**: each row becomes `audience='link'`
  **keeping the same token value**, so every existing `/ship/[itemId]?token=`
  URL keeps working; `user_id` resolves to the registration currently owning
  `item_id` (rows whose item is gone become orphans, surfaced in the UI). The
  old `unique (user_id, item_id)` is dropped — an item can now have several
  shares with different audiences.
- **Query-time evaluation**: the shared-rows policy calls a helper
  `character_asset_share_visible(item_id, character_id) returns boolean`
  which (1) exits early unless the owning character has any live share row
  (one indexed probe — the common case), then (2) climbs the item's ancestor
  chain through current rows (the `asset_ancestors()` shape, depth-capped at
  16), and (3) matches shares on the item itself, an ancestor with
  `include_contents`, or the hangar wildcard. Because grantor and asset rows
  share the same `character_id`, the climb stays within rows the *share*
  already implies visibility for — the helper can therefore be written
  invoker-rights against the share-table policies plus the core policy it
  serves, but **verify recursion behavior in the PR** (a policy whose helper
  reads the same table re-enters that policy; if Postgres's RLS recursion
  guard bites, scope the climb to a `security_barrier` view over shared rows
  instead — still no definer).
- The shared container/ship row itself is always visible (so a share page can
  render its name and location); `public` audience requires the anon grant on
  `character_asset_over_time` + the `character_asset` view.

### Stage F — Asset item filters

Four nullable filter columns on `character_asset_share`:

```sql
filter_category_ids bigint[], filter_group_ids bigint[],
filter_type_ids bigint[],     filter_item_ids bigint[]
```

- Semantics: an item matches if it's in **any** provided set (OR across the
  filters that are non-null); all null = everything. Category/group resolve
  via `sde_published_type` inside the helper (SDE mirror is public-read, so
  this works for anon/link viewers too).
- Filters constrain the *contents* reached through `include_contents`; the
  shared container itself stays visible.
- Schema + helper + share-page enforcement first; filter-editing UI can follow.

### Later / out of scope for now

- `corp_asset_share` (mirrors stages E–F with corp grantor + Director gate).
- A `user` audience (share to a specific named account).
- `account_share` — opt-in alt-mapping disclosure (see Alt privacy).
- Expiry UI (`expires_at` exists and is enforced from day one).
- Per-den / per-item share UI beyond what each stage ships.

## Staged PR plan

One PR per row, in order. Each schema PR follows the repo's migration rule:
edit `schema.sql` (full-reset truth) **and** add a non-destructive incremental
migration under `supabase/migrations/`.

| PR | Stage | Contents | Notes for the implementer |
|---|---|---|---|
| 1 | — | This design revision | Done in this PR. |
| 2 | A | `character` directory table + `character-directory` extract job | New table per "Identity split" (PK `character_id` bigint; **no `user_id`**; nullable unique `registration_id`). Job: seed ids from `registration`, resolve via `POST /universe/characters/affiliation/` (bulk, no auth → corp + alliance per character), then `GET /corporations/{id}/` and `GET /alliances/{id}/` (public, no auth) for names + `corporation.alliance_id` / `alliance` rows. Add the two public GET wrappers to `src/esi.js`. **Subsumes and retires `character-affiliations`** (same source endpoint): take over its 11:41 daily slot and its duties (upsert `character_affiliation`, refresh `registration.corporation_id`) so the endpoint isn't pulled twice; keep the old table until nothing reads it. Note: this also finally populates `corporation.alliance_id`, which the *existing* `corp_structure` alliance policy already depends on. Directory covers registered characters now; extending to other seen ids (e.g. `corp_industry_job.installer_id`) is a later nicety. |
| 3 | B | Den shares on the new model + shared helpers | `my_corporation_ids` / `my_alliance_ids` / `share_audience_matches` (invoker; land here since this is their first consumer). Rebuild `character_mercenary_den_share` (1:1 migration), rewrite den/status policies as plain joins, delete both definer helpers, re-key enemy intel (`reporter_id` + backfill), rework the picker (per-character rows, alliance targets, orphan list). `/mercenary-dens` owner-name resolution switches to the `character` directory. Depends on PR 2. |
| 4 | C | `character-roles` extract + `is_director()` | Independent of PR 3; must precede PR 5. Scope opt-in UI + refresh-matrix row like any per-character job. |
| 5 | D | `corp_structure_share` + seeded alliance default + policy cutover | Seed rows for every existing corp in the migration itself (cutover parity), `structure_share_seeded_at` for seed-once, Director-gated writes, opt-out UI on `/structure`. Depends on PRs 2 (alliance resolution), 3 (helpers), 4 (Director). |
| 6 | E | `character_asset_share` + `shared_asset_token` migration + containment helper | Tokens preserved so existing URLs keep working. Resolve the RLS recursion question flagged in Stage E before merging. Depends on PR 3 (helpers). |
| 7 | F | Asset filter columns + filter evaluation | OR semantics across provided sets; SDE-resolved category/group. UI can trail. Depends on PR 6. |
| 8 | — | (optional) `corp_asset_share` | Mirrors PRs 6–7 with corp grantor + Director gate. |

## Non-goals / invariants

- Shares are **read-only** grants; there is no shared-write concept.
- **No SECURITY DEFINER in the sharing layer** (see Identity split). The
  service role appears only where it always has: extract jobs and server-side
  `link`-token resolution.
- `user_id` never appears in a world-readable table; alt correlation stays
  impossible without the owner's explicit future opt-in (`account_share`).
- Shares never widen fuel (`corp_structure_status`), rigs, wallets, orders,
  industry jobs, clones, implants, or any table without a `_share` sibling.
- The MCP tools and Sheets CSV endpoints query as the caller, so RLS-granted
  shared rows surface there automatically and consistently — no separate code
  path.
- Universal/public reference tables (`industry_system_index`, `sde_*`,
  `corporation`, `alliance`, `universe_name`, and now `character`) are
  world-readable by design.
