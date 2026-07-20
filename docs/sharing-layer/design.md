# Sharing layer — data architecture

Design for a uniform, table-driven sharing layer: for every core table a
sibling `<table>_share` table, and RLS of the shape **"read your own rows, or
rows a matching share row grants you."** Replaces the three ad-hoc mechanisms
live today, in stages (dens → structures → assets → asset filters).

## Current state (what this replaces)

| Data | Mechanism today | Shape |
|---|---|---|
| Mercenary dens | `character_mercenary_den_share` | All-or-nothing per (character → corporation); no per-den rows, no alliance audience. Also gates `mercenary_den_enemy_intel` visibility. |
| Structures | Hard-coded RLS policy on `corp_structure` | Alliance-mates read the core table unconditionally (dynamic via `corporation.alliance_id`); no opt-out. Fuel already split into `corp_structure_status` (own-corp only). |
| Assets | `shared_asset_token` | Public per-item token links, resolved server-side via the service role; no anon RLS. |

## Core model

Every share row answers three questions:

- **Grantor** — who is sharing. For character-owned data this is the
  **account** (`user_id`), not the character: `characterID` can transfer to
  another owner, `user_id` is the durable identity. For corp-owned data the
  grantor is the **corporation** (`corporation_id`), with a `created_by` user
  for audit.
- **Subject** — what is shared. A per-table object id (`den_id`, `structure_id`,
  `item_id`), **nullable = wildcard** ("all my rows in this table"). Tables can
  add narrower scope columns (dens keep an optional `character_id` scope so
  "all of *this character's* dens" — today's semantic — survives the move to
  user-keyed shares).
- **Audience** — who may see it. Four kinds:

| `audience` | Target column | Resolution |
|---|---|---|
| `corporation` | `audience_corporation_id` | Static: viewer has a registration in that corp. |
| `alliance` | `audience_corporation_id` | **Dynamic**: resolved at query time to that corp's *current* alliance via `corporation.alliance_id`. If the corp changes alliance, the share follows (lag = the corporation-resolution cadence; accepted). Stored as a corp, never as an alliance id. |
| `public` | — | True anon RLS: the underlying rows become selectable through the anon key. Enumerable by design. |
| `link` | `token` | Unguessable token (16 random bytes hex, like `shared_asset_token`). **Not expressed in RLS at all** — resolved server-side via the service role, which then scopes queries to the grantor's rows (today's `/ship/[itemId]?token=` pattern, generalized). |

`public` and `link` are distinct audiences: `link` means "anyone with the URL,"
`public` means "anyone at all, including direct anon-key queries."

### Ownership validity (automatic revocation on owner change)

A share is only honored while the grantor still owns the row. The RLS
predicate joins the core row's owner back to the share's grantor:

- Character-owned tables: `core.character_id → registration.id →
  registration.user_id = share.user_id`. An item that moves to another
  character **of the same user** keeps matching (new current row, same
  `user_id`); an item that lands on **another user's** character stops matching
  — the share row still exists but grants nothing.
- Corp-owned tables: `core.corporation_id = share.corporation_id`.

No cleanup job needed; invalidation is a property of the join.

### Common `_share` columns

```sql
create table public.<subject>_share (
  id                      uuid primary key default gen_random_uuid(),
  -- grantor (one of the two, per table family):
  user_id                 uuid references auth.users(id) on delete cascade,  -- character-owned
  corporation_id          bigint,                                            -- corp-owned (+ created_by uuid for audit)
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

### Shared helper functions (one migration, reused by every stage)

```sql
my_corporation_ids() returns setof bigint;  -- corps of the caller's registrations
my_alliance_ids()    returns setof bigint;  -- via corporation.alliance_id
share_audience_matches(audience text, audience_corporation_id bigint) returns boolean;
--  'public'      → true (works for anon too)
--  'corporation' → audience_corporation_id ∈ my_corporation_ids()
--  'alliance'    → corporation.alliance_id of audience_corporation_id ∈ my_alliance_ids()
--  'link'        → false (never granted via RLS)
```

Stable SQL functions, `(select auth.uid())` initplan-friendly.

### RLS policy pattern

On each core `_over_time` table, an additional **permissive SELECT policy**
OR'd with the existing own-rows policy (policies live on the base tables; the
`is_current` views inherit exactly as today):

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
      join public.registration r on r.id = <core>.character_id
      where s.user_id = r.user_id                       -- ownership validity
        and (s.<object_id> is null or s.<object_id> = <core>.<object_id>)
        and (s.expires_at is null or s.expires_at > now())
        and public.share_audience_matches(s.audience, s.audience_corporation_id)
    )
  );
```

Two consequences to be deliberate about:

- **The `_share` tables need their own read policies** so the `exists`
  subquery (running as the viewer) can see the rows aimed at it — same trick
  the den share table documents today. Owner gets `for all`; everyone else
  (including anon) gets SELECT on rows where `share_audience_matches(...)` is
  true. `link` rows never match, so tokens are never readable by non-owners.
- **`grant select ... to anon`** must be added to any core table that supports
  the `public` audience. The policy still gates every row; the grant just stops
  being an implicit second lock.

Writes to `_share` tables go through plain RLS (owner-managed for
character-owned data, Director-gated for corp-owned — see below), retiring the
service-role write path the den share UI uses today.

### History

Shares expose **current rows only** (`is_current`), never the SCD-2 history.
The owner keeps full history through the own-rows policy. Append-only
observation tables that back a "current" view (den status) get the same share
predicate keyed on the den — parity with what corpmates see today; if strictly
latest-only ever matters, swap the view join for a security-definer helper.

### Corp-share authority: Directors only

Creating/revoking shares of corp-owned data requires an in-game **Director**
role, which the app doesn't track yet. Prerequisite extract:

- **`character-roles`** job — ESI `GET /characters/{id}/roles/` (scope
  `esi-characters.read_corporation_roles.v1`), per-character, standard
  `src/jobs/` shape, every 6h. Table `character_role (character_id uuid pk
  references registration(id) on delete cascade, roles text[], recorded_at)`.
- Helper `is_director(corp_id)`: caller has a registration in `corp_id` whose
  `character_role.roles` contains `'Director'`. Used in the insert/update/delete
  policies on corp-owned `_share` tables.

## Per-table design

### Stage 1 — Mercenary dens

New-shape `character_mercenary_den_share` (replacing the current table):

```sql
user_id       uuid not null,             -- grantor account
character_id  uuid references registration(id) on delete cascade,  -- scope: only this character's dens (null = all)
den_id        bigint,                    -- scope: one den (null = all). Per-den supported in schema; no UI yet.
audience / audience_corporation_id / token / created_at / expires_at
```

- **Migration**: rename old table aside, transform each `(character_id,
  corporation_id)` row into `(user_id ← registration.user_id, character_id,
  den_id = null, audience = 'corporation', audience_corporation_id =
  corporation_id)`, drop the old table. Existing shares keep working
  unchanged.
- **Policies rewritten** on `character_mercenary_den_over_time`,
  `character_mercenary_den_status` (observations follow the den's share), and
  `mercenary_den_enemy_intel` (a user's sightings are visible to any viewer in
  the audience of *any* of that user's den shares — today's corp semantic,
  generalized).
- **UI** (`shareCorps.tsx`): same corp UX, plus the motivating new option —
  **share with alliance** (stored as `audience='alliance'` against the chosen
  corp, so it tracks alliance changes). `public`/`link` supported by the
  schema, no den UI for them yet.

### Stage 2 — `character-roles` extract

The Director prerequisite, as described above. Ships independently of any
sharing behavior: scope opt-in on `/account/settings`, job, table, freshness
row on `/character/refresh`.

### Stage 3 — Structures

`corp_structure_share`: grantor `corporation_id` (+ `created_by`), subject
`structure_id` (null = all corp structures), same audience columns.

- **Seeded default**: migration inserts `(corporation_id, structure_id = null,
  audience = 'alliance', audience_corporation_id = corporation_id)` for every
  corp already in `corp_structure`, then the hard-coded "Alliance members read
  corp structures" policy is dropped and replaced by the share-driven one —
  behavior identical at cutover, but now visible and revocable.
- **Seed-once**: `corporation.structure_share_seeded_at timestamptz`; the
  `corp-structures` extract seeds the default row only when null, then stamps
  it — so a Director deleting the row (opting out) is never re-seeded.
- **Fuel and rigs stay private**: `corp_structure_status` (fuel timer) and
  `corp_structure_rig` keep their own-corp-only policies; shares never widen
  them.
- **Writes**: `is_director(corporation_id)` RLS on the share table. `/structure`
  gains a Directors-only control to toggle the alliance default (and later,
  per-structure `link`/`public` shares).

### Stage 4 — Character assets

`character_asset_share`: grantor `user_id`, subject `item_id` (null = whole
hangar), `include_contents boolean not null default true` (sharing a
container/ship shares what's inside it, recursively), audience columns.

- **Migration from `shared_asset_token`**: each row becomes `audience='link'`
  **keeping the same token value**, so every existing `/ship/[itemId]?token=`
  URL keeps working. The `/ship` resolution switches to the new table (same
  service-role pattern). The old `unique (user_id, item_id)` is dropped — an
  item can now have several shares with different audiences.
- **Query-time evaluation** (chosen over materialization): the shared-rows
  policy calls a `security definer` helper
  `character_asset_share_visible(item_id, registration_id) returns boolean`
  which:
  1. cheap guard first — `exists` any live share row for the row-owner's
     `user_id` (one indexed probe; hangars whose owner shares nothing exit
     here, which is almost every row RLS ever evaluates);
  2. climbs the item's ancestor chain through current rows (the
     `asset_ancestors()` shape, depth-capped at 16);
  3. returns true if a live share by that user matches: `item_id is null`
     (hangar wildcard), equals the item itself, or equals an ancestor with
     `include_contents` — and the audience matches (and, stage 5, the filters
     match).

  `security definer` is required because the climb reads rows the viewer can't
  see yet; it returns only a boolean. Always instantly fresh; the accepted
  trade-off is up to ~16 indexed lookups per candidate row on reads that reach
  past the guard.
- The shared container/ship row itself is always visible (so a share page can
  render its name and location); `public` audience requires the anon grant on
  `character_asset_over_time` + the `character_asset` view.

### Stage 5 — Asset item filters

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

- `corp_asset_share` (mirrors stages 4–5 with corp grantor + Director gate).
- A `user` audience (share to a specific named account).
- Expiry UI (`expires_at` exists and is enforced from day one).
- Per-den share UI (schema supports it from stage 1).
- Widening the Director gate to other roles (e.g. Station_Manager).

## Staged PR plan

| PR | Contents | Depends on |
|---|---|---|
| 0 | This design doc | — |
| 1 | Shared helpers (`my_corporation_ids`, `my_alliance_ids`, `share_audience_matches`) + den share table replacement, data migration, rewritten den/status/intel policies, alliance option in the share UI | — |
| 2 | `character-roles` extract (scope, job, table, `is_director`) | — |
| 3 | `corp_structure_share` + seeded alliance default + policy cutover + Director-gated writes + opt-out UI | 1 (helpers), 2 (Director) |
| 4 | `character_asset_share` + `shared_asset_token` migration (tokens preserved) + containment helper + policies + `/ship` cutover | 1 |
| 5 | Asset filter columns + filter evaluation | 4 |
| 6 (optional) | `corp_asset_share` | 2, 4 |

Each PR follows the repo's migration rule: edit `schema.sql` (full-reset truth)
**and** add a non-destructive incremental migration under
`supabase/migrations/`.

## Non-goals / invariants

- Shares are **read-only** grants; there is no shared-write concept.
- Shares never widen fuel (`corp_structure_status`), rigs, wallets, orders,
  industry jobs, clones, implants, or any table without a `_share` sibling.
- The MCP tools and Sheets CSV endpoints query as the caller, so RLS-granted
  shared rows surface there automatically and consistently — no separate code
  path.
- Universal/public reference tables (`industry_system_index`, `sde_*`,
  `corporation`, `alliance`, `universe_name`) are unaffected; they're already
  world-readable by design.
