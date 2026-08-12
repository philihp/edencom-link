# Per-account structure universe

Status: design, not built.

## Problem

`/structure` today lists exactly one thing: `corp_structure`, the Upwell
structures owned by corporations the account has a character in (widened to
alliance-mates by a second policy). That is the set of structures the account
*owns*, not the set it can *use*.

What a player actually wants on that page is their **universe of structures**:
everywhere any of their characters can dock. That set differs per account —
and, strictly, per character, since docking is an ACL evaluated per pilot. It
overlaps heavily between accounts in the same alliance but is never identical,
so it cannot be a single global table.

## What is actually obtainable

A genuinely complete list of player-anchored structures **does not exist in any
data source we can reach**, and it is worth stating that before designing
around it.

Measured 2026-08-12:

| Source | Structures |
|---|---|
| ESI `GET /universe/structures` | 886 ids |
| EVE Ref `structures-latest.v2.json` | 2,374 rows, 1,444 with a name |

ESI's public list is documented as *fully public* only — "a completely open
Access Control List". Everything else in New Eden is invisible to ESI unless one
of your own characters has access to it. EVE Ref does better (it scrapes the
public endpoints continuously and backfills from Adam4EVE) but is still under
2.5k rows, which is nowhere near the anchored total.

So "complete" has to be redefined as **everything your characters can see**,
which *is* obtainable and is what the job should target:

    own corp + alliance structures
  ∪ every structure id already present in the account's extracted data
  ∪ the publicly-listed structures
  ∪ EVE Ref's snapshot, as an identity fallback only

### How jEveAssets does it

It does not enumerate. `CitadelSource` is a **prioritised resolver**, not a
discovery mechanism — ESI corp structures ("certified fresh") over ESI
locations ("good source") over planet/moon derivation over user-entered data,
with zKillboard and the Hammertime Citadel Hunt API ranked last and explicitly
labelled "outdated source". It learns about a structure because an id showed up
in the player's own data, then races several sources to put a name on it.

The Hammertime API is dead as of this writing (connection refused), which is
why jEveAssets demoted it. EVE Ref is its live successor.

### The search endpoint is off the table

`GET /characters/{id}/search?categories=structure` is ACL-filtered and looks
like the answer. It is not, for two reasons:

- `minLength: 3` makes exhaustive enumeration combinatorially impossible.
- **CCP has publicly warned that using `/search/` as a discovery endpoint —
  citadel discovery named specifically — is an API-policy violation that gets
  developers banned from ESI.**

Do not add `esi-search.search_structures.v1` for this.

## The three axes the current schema conflates

A structure carries three independent kinds of fact, each with its own
audience. `corp_structure` currently holds the first and third together, and
the second does not exist at all.

1. **Identity** — name, solar system, hull type, owning corporation. Not
   secret: anyone who warps to the grid reads it off the overview. One global
   row per structure, shared by every account.
2. **Reachability** — can *this character* dock here. Per-character truth,
   presented as a per-account union. This is the missing many-to-many.
3. **Operator facts** — what the owning corp knows: state, service modules,
   reinforcement windows, fitted rigs, fuel. Corp-scoped, and itself tiered.

## Tables

### `universe_structure` — the directory (axis 1)

Already exists, already has the right RLS ("established accounts read"), and is
already populated incidentally by the `universe-structures` job from asset and
clone locations. The rework keeps the table and widens what fills it, adding
two columns:

```sql
alter table public.universe_structure
  add column owner_corporation_id bigint,   -- universe/structures/{id}.owner_id
  add column is_public boolean not null default false;  -- seen in GET /universe/structures
```

`owner_id` comes back free on every successful `/universe/structures/{id}`
probe, so ownership no longer needs a corp token to learn.

Deliberately *not* renamed to `structure`: the name already reads as "the
player-structure directory", and the rename would touch the market-order join,
asset location resolution, and the MCP tools for no semantic gain.

### `structure_access` — the many-to-many (axis 2)

```sql
create table public.structure_access (
  registration_id uuid   not null references public.registration (id) on delete cascade,
  structure_id    bigint not null references public.universe_structure (structure_id) on delete cascade,
  can_dock   boolean     not null,
  checked_at timestamptz not null default now(),
  source     text,  -- 'public-list' | 'asset' | 'clone' | 'corp' | 'search' | 'manual'
  primary key (registration_id, structure_id)
);
```

Keyed on **`registration_id`** (the character), not `user_id`:

- Docking access is a per-character ACL. A character-level key stores the truth
  and derives the account view as a union; a user-level key stores the union and
  can never recover the truth.
- It answers "which of my alts can dock here", which is the question that
  actually matters when planning a haul.
- Deleting a character cascades its access away for free.
- Named `registration_id`, correctly — this is a registration uuid, not an EVE
  numeric id. (See `docs/registration-id-rename.md` for why most sibling tables
  get this wrong.)

RLS is the standard character-owned pattern:

```sql
using (registration_id in (
  select id from public.registration where user_id = (select auth.uid())
))
```

**Negative rows are stored deliberately.** A `can_dock = false` row is the memo
that stops the probe from re-403ing the same structure every run — see the ESI
error budget below. Negative rows get a longer re-check TTL than positive ones,
since access is granted more often than it is revoked.

### `structure_favorite` — pinning (axis 2, user-level)

```sql
create table public.structure_favorite (
  user_id      uuid   not null references auth.users (id) on delete cascade,
  structure_id bigint not null references public.universe_structure (structure_id) on delete cascade,
  created_at timestamptz not null default now(),
  position   integer not null default 0,
  primary key (user_id, structure_id)
);
```

A structural copy of `watched_system`, down to the `position` column and the
"users manage own" policy — same shape, same server-action pattern, same drag
ordering if it ever wants it. Account-level, not per-character: a favorite is a
UI preference, not an ACL fact.

## Visibility ladder (axis 3)

| Table | Contents | Audience | Change |
|---|---|---|---|
| `universe_structure` | name, system, type, owner | any established account | populate far wider |
| `structure_access` | can this character dock | the owning account | **new** |
| `corp_structure` | state, services, reinforce hours, unanchors_at | own corp + alliance | none — already correct |
| `corp_structure_rig` | fitted rigs | own corp → **+ alliance** | widen |
| `corp_structure_status` | fuel_expires, profile_id | own corp → **directors only** | narrow |

Widening the rigs is the easy half: copy the "Alliance members read corp
structures" policy verbatim onto `corp_structure_rig`. The justification is that
a fitted rig is inferable from the structure's own bonuses in space, so it was
never really corp-private.

Narrowing the status is the half that needs new data.

## Knowing who is a director

Nothing in the schema records in-game roles today. Two routes:

### (a) Observed capability — free, no re-auth *(recommended)*

`GET /corporations/{id}/structures` requires the Station_Manager role. A token
that pulls it successfully has proven the role; a token that 403s has proven the
absence. `forEachCorporation` already distinguishes exactly this case — the
role-denial path that writes `heartbeat.skipped_reason` — so the signal is
already being computed and then thrown away.

```sql
create table public.corp_role_grant (
  registration_id uuid   not null references public.registration (id) on delete cascade,
  corporation_id  bigint not null,
  role text not null,          -- 'station_manager', later 'director', 'accountant', …
  observed_at timestamptz not null default now(),
  primary key (registration_id, corporation_id, role)
);
```

Written by `corp-structures` on success, deleted on a role-denial 403. The
`corp_structure_status` policy becomes "the caller has a registration holding a
`station_manager` grant for this corporation".

Costs nothing and prompts nobody. Its limit is that it only knows about
characters the app actually uses for a pull.

### (b) Real roles pull

`GET /characters/{id}/roles` under `esi-characters.read_corporation_roles.v1`.
Truthful and general — it would unlock accountant//hangar-role gating later —
but it is a **new scope**, so every already-linked character needs re-auth, and
it reads as invasive on the consent screen.

Take (a) now, shaped so (b) can later populate the same table with real roles
and the policies never change.

**Consequence to accept:** rank-and-file corp members lose the fuel column on
`/structure`. The low-fuel Discord alerts are unaffected — that job runs
service-role and never sees RLS.

## Jobs

Two jobs, split by who owns the result and what it costs.

### `structure-directory` — account-wide, daily

Identity only, shared by every account, no per-character work:

- `GET /universe/structures` → upsert ids, set `is_public`.
- EVE Ref `structures-latest.v2.json` → name, owner, system, type, region for
  ids ESI will not resolve for us. Lowest priority: never overwrite a field we
  resolved ourselves from ESI, exactly as jEveAssets ranks its sources.

Single-step workflow, cheap, one heartbeat. Nothing here is per-user, so it does
not need a refresh lever.

### `structure-access` — per-character, daily, **and the lever**

This is the job the user pulls. Per-character fan-out shape, so registering it
in `PER_CHARACTER_JOBS` gives it a `/jobs` row with a per-character refresh
button and `refresh_task` tracking for free — that is the "refresh my
structures" control, with a shortcut button on `/structure` pointing at the same
dispatch. Daily on the cron otherwise.

For each of the account's characters:

1. **Harvest candidates from data we already hold.** No ESI calls at all — every
   one of these tables is already extracted and sitting in Postgres, and a
   structure id in them is proof the character has been there:
   - `character_asset` / `corp_asset` — `location_id`
   - `character_clone_over_time` — `location_id` where `location_type='structure'`
   - `character_order` / market orders — `location_id`
   - `character_industry_job` / `corp_industry_job` — `station_id`, `facility_id`,
     `blueprint_location_id`, `output_location_id`
   - `character_contract` / `corp_contract` — `start_location_id`, `end_location_id`
   - `character_wallet_transaction` / `corp_wallet_transaction` — `location_id`
   - `corp_structure` — own corp and alliance
   This is where the great majority of a real account's universe comes from, and
   it costs nothing.
2. **Add the public list** from `universe_structure where is_public`.
3. **Probe** each candidate not already decided (or past its TTL) with
   `GET /universe/structures/{id}` on that character's token. 200 → `can_dock =
   true` plus fresh identity into `universe_structure`; 403 → `can_dock = false`.

Filtering NPC stations out is free: player structures are `structure_id >=
100_000_000_000` and NPC stations are `<= 64_000_000`. `universeStructures.js`
already carries that floor as `STRUCTURE_ID_FLOOR`.

### ESI error budget

**403s count against ESI's 100-errors-per-60s limit.** Probing a large candidate
set against a token that can dock at few of them will trip it and throttle the
whole deployment. The probe must:

- read `X-Esi-Error-Limit-Remain` / `-Reset` and back off before exhausting it;
- run under a bounded per-run probe budget with a persisted cursor, so a large
  candidate set drains across days rather than in one burst;
- never re-probe inside its TTL — short for `can_dock = true`, long for `false`.

This is the single hardest constraint in the feature, and it is why
`structure_access` stores negative rows.

## Page

`/structure` becomes a union with columns degrading by tier:

1. **Favorites** first (`structure_favorite`, `position` order), whatever tier.
2. **Ours** — corp/alliance structures, full columns; fuel only for directors.
3. **Dockable** — everything else in `structure_access` where `can_dock`:
   identity, system, type, owner corp, and which alts can dock. No state, no
   revenue, no rigs — we have no data for someone else's structure.

The revenue/index/sparkline machinery stays keyed to tier 2 only.

## Open questions

1. Do we take the EVE Ref dependency? It is the only way to name a structure we
   cannot dock at, but it is a third-party feed with no SLA — the same bet
   jEveAssets made, and the same bet that left it with a dead Hammertime source.
   The alternative is showing the raw id, which is what the SDE rule in
   `CLAUDE.md` already prescribes for unresolvable lookups.
2. Do the reinforcement hours in `corp_structure` stay alliance-visible? They are
   shown in-game to anyone who can see the structure, so probably yes — worth
   stating deliberately rather than inheriting.
3. Should `structure_access` be probed for *every* character, or only one
   character per corp? Docking ACLs are usually granted at corp/alliance level,
   so probing one pilot per corp would cut the ESI cost by the number of alts at
   the price of missing personally-granted access.
4. Should a user be able to add a structure id by hand (jEveAssets' `USER`
   source) for the case where they know a structure exists but nothing can
   resolve it?
