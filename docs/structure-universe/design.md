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

Split by cost and by who owns the result:

- **`structure-directory`** — account-wide, daily. Pulls `GET /universe/structures`
  (no auth, ~9k ids), upserts identity rows into `universe_structure`, flags
  `is_public`. Single-step workflow; cheap; shared by every account.
- **`structure-access`** — **per-character**, the lever. Probes candidates with
  `GET /universe/structures/{id}` per token; a 200 writes `can_dock = true` plus
  refreshed identity, a 403 writes `can_dock = false`. Per-character fan-out
  shape, so it lands in `PER_CHARACTER_JOBS` and inherits a `/jobs` row and a
  per-cell refresh button for free — that *is* the "refresh my universe" lever,
  plus a shortcut button on `/structure` itself.

Candidate pool per character, in priority order: own corp + alliance structures
→ locations of their assets, clones, orders, industry jobs and contracts →
public structures in systems they have ever been in → the rest of the public
list.

### ESI error budget

**403s count against ESI's 100-errors-per-60s limit.** A blind sweep of the
public list against a token that can dock at few of them will trip it and get
the whole app throttled. The probe therefore must:

- read `X-Esi-Error-Limit-Remain` / `-Reset` and back off before exhausting it;
- run under a bounded per-run probe budget with a persisted cursor, so a large
  candidate set drains across runs instead of in one burst;
- never re-probe a `can_dock = false` row inside its TTL.

This is the single hardest constraint in the whole feature, and it is why the
negative rows exist.

## Page

`/structure` becomes a union with columns degrading by tier:

1. **Favorites** first (`structure_favorite`, `position` order), whatever tier.
2. **Ours** — corp/alliance structures, full columns; fuel only for directors.
3. **Dockable** — everything else in `structure_access` where `can_dock`:
   identity, system, type, owner corp, and which alts can dock. No state, no
   revenue, no rigs — we have no data for someone else's structure.

The revenue/index/sparkline machinery stays keyed to tier 2 only.

## Open questions

1. Does "everything" include public structures the account has never been near,
   or only those in systems it has touched? The former is ~9k probes per
   character; the latter is a few hundred and covers nearly the same practical
   set.
2. Do the reinforcement hours in `corp_structure` stay alliance-visible? They
   are shown in-game to anyone who can see the structure, so probably yes — but
   it is worth stating deliberately rather than inheriting.
3. Is `esi-search.search_structures.v1` worth adding as a fourth candidate
   source? Its `minLength: 3` makes exhaustive enumeration impossible, so it
   only helps as a per-system-name sweep, and it costs a re-auth.
