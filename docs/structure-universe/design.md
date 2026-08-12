# Per-account structure universe

Status: design, not built.

## Problem

`/structure` today lists exactly one thing: `corp_structure`, the Upwell
structures owned by corporations the account has a character in (widened to
alliance-mates by a second policy). That is the set of structures the account
*owns*, not the set it can *see*.

Two things are missing: a per-account lever to refresh that set on demand, and
a name for every structure that shows up elsewhere in the app.

## What is actually obtainable

A genuinely complete list of player-anchored structures **does not exist in any
data source we can reach**. Measured 2026-08-12:

| Source | Structures |
|---|---|
| ESI `GET /universe/structures` | 886 ids, no names |
| EVE Ref `structures-latest.v2.json` | 2,374 rows, 1,444 with a name |

ESI's public list is documented as *fully public* only — "a completely open
Access Control List". Everything else in New Eden is invisible to ESI unless one
of our own characters has access.

### How jEveAssets does it

It does not enumerate. `CitadelSource` is a **prioritised resolver** — ESI corp
structures ("certified fresh") over ESI locations ("good source") over
planet/moon derivation over user-entered data, with zKillboard and the
Hammertime Citadel Hunt API ranked last and explicitly labelled "outdated
source". It learns about a structure because an id showed up in the player's own
data, then races several sources to put a name on it.

Hammertime is dead as of this writing (connection refused), which is why
jEveAssets demoted it. EVE Ref is its live successor.

### The search endpoint is off the table

`GET /characters/{id}/search?categories=structure` is ACL-filtered and looks
like the answer. It is not:

- `minLength: 3` makes exhaustive enumeration combinatorially impossible.
- **CCP has publicly warned that using `/search/` as a discovery endpoint —
  citadel discovery named specifically — is an API-policy violation that gets
  developers banned from ESI.**

Do not add `esi-search.search_structures.v1` for this.

### Docking access is not modelled

An earlier draft proposed a `structure_access` many-to-many recording, per
character, whether `GET /universe/structures/{id}` returned 200 or 403 — i.e.
whether that pilot can dock. **Dropped deliberately.** Docking access is not
what the page is for, and probing it was by far the most expensive and most
fragile part of the design: 403s count against ESI's 100-errors-per-60s budget,
so it needed error-limit backoff, a bounded per-run budget, a persisted cursor,
and TTL'd negative rows. None of that is needed to name a structure and show
what we know about it.

What remains is the split below: **corp structures via directors** for the rich
data, and **a universal directory** for names.

## The split

### 1. Rich data — director-driven, per account, on demand

For each of the account's characters that holds the in-game role, scan that
character's corp. This is where everything beyond a name comes from: state,
services, reinforcement windows, fuel, rigs.

**The trap:** rigs and fuel come from *different jobs*.

| Data | Table | Job |
|---|---|---|
| state, services, reinforce, unanchors_at | `corp_structure` | `corp-structures` |
| **fuel_expires, profile_id** | `corp_structure_status` | `corp-structures` |
| **fitted rigs** | `corp_structure_rig` | **`corp-assets`** |

ESI has no structure-fitting endpoint; rigs are inferred from corp *assets*
whose `location_flag` is a RigSlot (`src/jobs/corpAssets.js`). So a "refresh my
structures" lever must fan out **both** `corp-structures` and `corp-assets`, or
the rigs silently stay stale while everything beside them updates.

`corp-assets` is already in `PER_CORPORATION_JOBS`; `corp-structures` is not,
and needs adding. Both stay **per-corporation, one run per corp** — never one
run per director. Two directors in the same corp would race a concurrent
reconcile, which is the failure `dispatchRefresh.ts` already documents at
length: the loser's INSERT collides with the winner's committed row and can
abort partway through with rows closed but never reopened.

So: the lever is account-level, the fan-out is per-corp, and the set of corps is
"corps where this account has a director-capable character".

#### Knowing who is a director, for free

`GET /corporations/{id}/structures` requires the Station_Manager role. A token
that pulls it successfully has proven the role; one that gets the role-denial
403 has proven its absence. `forEachCorporation` **already classifies exactly
this** — it is the path that writes `heartbeat.skipped_reason` so `/jobs` can
say "not a director" instead of "✗ failed" — and then discards the fact.

```sql
create table public.corp_role_grant (
  registration_id uuid   not null references public.registration (id) on delete cascade,
  corporation_id  bigint not null,
  role text not null,          -- 'station_manager', later 'director', 'accountant', …
  observed_at timestamptz not null default now(),
  primary key (registration_id, corporation_id, role)
);
```

Written on success, deleted on role-denial. No new ESI scope, no re-auth. If
`esi-characters.read_corporation_roles.v1` is ever added it can fill the same
table with stated rather than inferred roles, and no policy changes.

### 2. Names — universal, hourly

`structure-directory`, a new single-step job with no per-user work at all:

- `GET /universe/structures` → ids, set `is_public`.
- EVE Ref `structures-latest.v2.json` → name, `owner_id`, system, type, region.

Both are small and unauthenticated (~874 KB total), so hourly is comfortable.
One heartbeat, a `/jobs` "shared universe" row, no refresh lever — nothing about
it is per-account.

Rows carry a `source` so precedence is explicit, following jEveAssets: a name we
resolved ourselves from ESI with a real token outranks EVE Ref's, and EVE Ref
never overwrites it.

#### `universe-structures` stays

The existing token-probe job still earns its place and should **not** be folded
into the directory. It is the only thing that can name a **non-public**
structure — one of ours, or one we hold assets in — because that needs a token
with access, and EVE Ref by construction only has what is publicly queryable.

It is not a sweep: it only resolves ids that already appear in our own extracted
data, pooled across characters and tried against each token until one succeeds.
That is precisely jEveAssets' ESI_LOCATIONS source, and it is already built.

Between the three sources — corp structures, the token probe, and the hourly
directory — every structure id the app can display should resolve to a name.

## Schema

### `universe_structure` — the directory

Exists, keeps its name, keeps its "established accounts read" RLS. Gains:

```sql
alter table public.universe_structure
  add column owner_corporation_id bigint,   -- everef owner_id / universe/structures/{id}
  add column is_public boolean not null default false,
  add column source text;                   -- 'esi-token' | 'everef' | 'public-list'
```

Not renamed to `structure`: the name already reads correctly and the rename
would churn the market-order join, asset location resolution and the MCP tools
for no semantic gain.

### `structure_favorite` — pinning

```sql
create table public.structure_favorite (
  user_id      uuid   not null references auth.users (id) on delete cascade,
  structure_id bigint not null,
  created_at timestamptz not null default now(),
  position   integer not null default 0,
  primary key (user_id, structure_id)
);
```

A structural copy of `watched_system`, down to `position` and the "users manage
own" policy. Account-level, not per-character: a favorite is a UI preference,
not a fact about a pilot. No FK to `universe_structure` — a user may favorite a
structure the directory has not learned about yet.

### Visibility ladder

| Table | Contents | Audience | Change |
|---|---|---|---|
| `universe_structure` | name, system, type, owner | any established account | populate far wider |
| `structure_favorite` | pinned structures | the owning user | **new** |
| `corp_structure` | state, services, reinforce | own corp + alliance | none — already correct |
| `corp_structure_rig` | fitted rigs | own corp → **+ alliance** | widen |
| `corp_structure_status` | fuel, profile_id | own corp → **directors only** | narrow |

Widening the rigs is a copy of the existing "Alliance members read corp
structures" policy onto `corp_structure_rig`; a fitted rig is inferable from the
structure's bonuses in space, so it was never really corp-private.

Narrowing the status gates on `corp_role_grant`. **Consequence to accept:**
rank-and-file corp members lose the fuel column. The low-fuel Discord alerts are
unaffected — that job runs service-role and never sees RLS.

## Page

`/structure` sorts favorites to the top, then degrades by tier:

1. **Favorites** — `structure_favorite`, `position` order, whatever tier.
2. **Ours** — corp/alliance structures, full columns; fuel only for directors.
3. **Everything else we can name** — identity from `universe_structure`. No
   state, no revenue, no rigs; we have no data for someone else's structure.

The revenue/index/sparkline machinery stays keyed to tier 2 only.

NPC stations are excluded by id range, not by a lookup: player structures are
`>= 100_000_000_000`, NPC stations `<= 64_000_000`. `universeStructures.js`
already carries the floor as `STRUCTURE_ID_FLOOR`.

## Open questions

1. Do we take the EVE Ref dependency? It is the only way to name a structure no
   token can reach, but it is a third-party feed with no SLA — the same bet
   jEveAssets made, and the same bet that left it with a dead Hammertime source.
   The fallback is showing the raw id, which is what the SDE rule in `CLAUDE.md`
   already prescribes for unresolvable lookups.
2. Does tier 3 mean *every* structure in the directory (~2.4k rows, universe-wide)
   or only ones the account has touched? "A name for every location that
   matters" suggests the directory is for resolution and the page stays scoped —
   worth confirming before building the query.
3. Do the reinforcement hours in `corp_structure` stay alliance-visible? They are
   shown in-game to anyone who can see the structure, so probably yes — worth
   stating deliberately rather than inheriting.
4. Should a user be able to add a structure id by hand (jEveAssets' `USER`
   source) for the case where they know a structure exists but nothing resolves it?
