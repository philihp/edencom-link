# Per-account structure universe

Status: built (PR #879).

## Problem

`/structure` today lists exactly one thing: `corp_structure`, the Upwell
structures owned by corporations the account has a character in (widened to
alliance-mates by a second policy). That is the set of structures the account
_owns_, not the set it can _see_.

Two things are missing: a per-account lever to refresh that set on demand, and
a name for every structure that shows up elsewhere in the app.

## What is actually obtainable

A genuinely complete list of player-anchored structures **does not exist in any
data source we can reach**. Measured 2026-08-12:

| Source                              | Structures                    |
| ----------------------------------- | ----------------------------- |
| ESI `GET /universe/structures`      | 886 ids, no names             |
| EVE Ref `structures-latest.v2.json` | 2,374 rows, 1,444 with a name |

ESI's public list is documented as _fully public_ only — "a completely open
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

**The trap:** rigs and fuel come from _different jobs_.

| Data                                     | Table                   | Job               |
| ---------------------------------------- | ----------------------- | ----------------- |
| state, services, reinforce, unanchors_at | `corp_structure`        | `corp-structures` |
| **fuel_expires, profile_id**             | `corp_structure_status` | `corp-structures` |
| **fitted rigs**                          | `corp_structure_rig`    | **`corp-assets`** |

ESI has no structure-fitting endpoint; rigs are inferred from corp _assets_
whose `location_flag` is a RigSlot (`src/jobs/corpAssets.js`). So a "refresh my
structures" lever must fan out **both** `corp-structures` and `corp-assets`, or
the rigs silently stay stale while everything beside them updates.

`corp-assets` was already in `PER_CORPORATION_JOBS`; `corp-structures` joined it
(and its workflow moved from the single-step shape to the per-corporation
fan-out). Both stay **per-corporation, one run per corp** — never one
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
create table public.corp_job_access (
  registration_id uuid   not null references public.registration (id) on delete cascade,
  corporation_id  bigint not null,
  job  text not null,          -- the extract tag that proved it, e.g. 'corp-structures'
  observed_at timestamptz not null default now(),
  primary key (registration_id, corporation_id, job)
);
```

Written on success, deleted on role-denial, in `forEachCorporation` itself so
every corp job records it — best-effort, since bookkeeping must not fail an
extract that succeeded. No new ESI scope, no re-auth.

Keyed on the **job tag rather than a role name** on purpose: ESI never tells us
which role the pilot holds, only whether the call was allowed. "Can pull
`corp-structures` for corp X" is exactly what we observed, and exactly what the
fuel policy needs. If `esi-characters.read_corporation_roles.v1` is ever added
it can fill the same table with stated roles and no policy changes.

### 2. Names — universal, daily

`structure-directory`, a new single-step job with no per-user work at all:

- `GET /universe/structures` → ids, set `is_public`.
- EVE Ref `structures-latest.v2.json` → name, `owner_id`, system, type, region.

Both are small and unauthenticated (~874 KB total). Daily at 09:47, ten minutes
ahead of `universe-structures`: the directory seeds ids and names what it can,
so the token probe that follows spends its attempts only on what the public
feeds couldn't name. One heartbeat, a `/jobs` "shared universe" row, no refresh
lever — nothing about it is per-account.

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

Between the three sources — corp structures, the token probe, and the daily
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

| Table                   | Contents                   | Audience                      | Change                 |
| ----------------------- | -------------------------- | ----------------------------- | ---------------------- |
| `universe_structure`    | name, system, type, owner  | any established account       | populate far wider     |
| `structure_favorite`    | pinned structures          | the owning user               | **new**                |
| `corp_structure`        | state, services, reinforce | own corp + alliance           | none — already correct |
| `corp_structure_rig`    | fitted rigs                | own corp → **+ alliance**     | widen                  |
| `corp_structure_status` | fuel, profile_id           | own corp → **directors only** | narrow                 |

Widening the rigs is a copy of the existing "Alliance members read corp
structures" policy onto `corp_structure_rig`; a fitted rig is inferable from the
structure's bonuses in space, so it was never really corp-private.

Narrowing the status gates on `corp_job_access`. **Consequence to accept:**
rank-and-file corp members lose the fuel column. The low-fuel Discord alerts are
unaffected — that job runs service-role and never sees RLS.

## Page

Three blocks (`src/app/structure/roster.ts`, tested):

1. **Favorites** — `structure_favorite`, `position` order. A pin wins outright,
   so a favorite can be a structure from either block below.
2. **Our structures** — what a director token scans, which is exactly what the
   `corp_structure` select returns (RLS is own-corps OR alliance-mates), _plus_
   anything owned by a corporation one of our characters is in. That second
   clause is not redundant: a structure our own corp owns is absent from
   `corp_structure` whenever no linked character holds Station_Manager there,
   and filing our own Athanor under everyone else's would be perverse.
3. **Everyone else's structures** — every player structure appearing as a job
   location (`station_id`, falling back to `facility_id`) on one of our own
   industry jobs and not covered above, named from `universe_structure`.

Block 3 was originally struck out as "structures outside the alliance don't
belong on this page." That was wrong about which structures those are. Renting
slots is normal, and the structure a corp's own jobs run in is the most relevant
structure it doesn't own: before this, it appeared only as ISK under "taxes paid
elsewhere", with no tile to belong to. Discovery is seeded from **our** jobs
only — never from the jobs `industry_job_tax_facility()` resolves, which are
other players renting our slots — so the block is "structures we use", not a
directory dump.

No director means no fitting and no capabilities: what a block 3 tile shows is
what ESI hands any visitor — a name, a system, a type and an owner — and a
structure the directory has never resolved still gets a tile, with those fields
reading "—" rather than being invented. Both own-corp side tables
(`corp_structure_status`, `corp_structure_rig`) are asked only about scanned
ids, since a structure we don't scan can only ever come back empty.

A favorite may now be a structure the caller can't scan, which the star already
handled: `structure_favorite` has no FK to any structure table, deliberately.

That does _not_ make the directory pointless: naming structures is what it is
for. Asset paths, market orders, industry job locations and contract endpoints
all render structure ids elsewhere in the app, and the daily job is what turns
those into names.

NPC stations are excluded by id range, not by a lookup: player structures are
`>= 100_000_000_000`, NPC stations `<= 64_000_000`. `universeStructures.js`
already carries the floor as `STRUCTURE_ID_FLOOR`; `roster.ts` carries the
same constant for the same reason, so a job installed in Jita 4-4 gets no tile.

## Decisions

1. **EVE Ref: taken.** It is the only way to name a structure no token of ours
   can reach. The risk is a third-party feed with no SLA — the same bet
   jEveAssets made, and the same bet that left it with a dead Hammertime source.
   Contained by `source` precedence: if the feed dies, the rows it wrote stay,
   and everything a token resolved is untouched.
2. **Page scope: alliance only.** See above.
3. **Docking probes: not built.** Dockability is not what the page needs.
4. Reinforcement hours stay alliance-visible (unchanged from today — they are
   shown in-game to anyone who can see the structure).

Still open: whether a user should be able to add a structure id by hand
(jEveAssets' `USER` source) for the case where they know a structure exists but
nothing resolves it.
