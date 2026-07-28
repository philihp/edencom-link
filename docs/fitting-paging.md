# Plan: fitting paging — an unbounded library over the game's 500-fit cap

EVE caps how many personal fittings a character can keep saved in the game
(500). This plan treats that cap the way an OS treats physical memory: the
game client's saved list is the **resident set** (500 frames), and this site's
database is the **backing store** (unbounded). A fit the player wants but
hasn't room for gets **paged in** (written back to the game via ESI); a fit
they aren't flying gets **paged out** (archived here, deleted from the game).
The player's _library_ — every fit they've ever kept — lives on this site;
the game holds only the working set.

Status: **plan only.** Nothing below is built. It builds on the shipped
read-only fittings feature (`docs/fittings.md`: scope #742, extract #743,
`/fitting` page #744, MCP tool #745).

## Why this is possible at all

ESI's fittings API has exactly three endpoints (verified against
`esi.evetech.net/meta/openapi.json`, see `docs/fittings.md`):

| Endpoint                                | Scope                            |
| --------------------------------------- | -------------------------------- |
| `GET /characters/{id}/fittings`         | `esi-fittings.read_fittings.v1`  |
| `POST /characters/{id}/fittings`        | `esi-fittings.write_fittings.v1` |
| `DELETE /characters/{id}/fittings/{id}` | `esi-fittings.write_fittings.v1` |

The POST body is `{ name, description, ship_type_id, items[{type_id, flag,
quantity}] }` — **exactly the shape `character_fitting_over_time` already
stores** (the extract's `normalizeItems` keeps all three item fields). So the
archive we've been building since #743 is already a byte-complete swap file;
paging in is a straight replay of a stored row.

## The identity problem (read this before the schema)

`fitting_id` is assigned by the game server on POST. Page a fit out and back
in and it comes back with a **new** `fitting_id`. So the game's id cannot be
the durable identity of a library entry — it's the _frame number_, not the
_page_. The SCD table keys on `(character_id, fitting_id)` and must stay that
way (it mirrors what ESI reports); the library needs its own key:

- **`library_id`** — a uuid we mint, the stable identity a player pins,
  restores, and links to.
- **`content_hash`** — sha256 over the normalized
  `(ship_type_id, name, description, items)`, used to recognize "this fit is
  already resident" (dedupe before POST) and to re-attach a library entry to
  the live fit the extract sees after a page-in.

## New tables

```
fitting_library                    -- the durable pages
  library_id     uuid pk
  character_id   uuid → registration(id) on delete cascade
  name           text not null
  description    text
  ship_type_id   bigint not null
  items          jsonb not null            -- normalized, POST-ready
  content_hash   text not null
  resident_fitting_id bigint              -- game id while resident, else null
  pinned         boolean not null default false   -- never auto-evicted
  evicted_at     timestamptz               -- null while resident
  created_at / updated_at timestamptz
  unique (character_id, content_hash)

fitting_page_op                    -- the intent log / audit trail
  id             bigint identity pk
  character_id   uuid → registration(id)
  library_id     uuid → fitting_library(library_id)
  op             text not null             -- 'page_in' | 'page_out'
  status         text not null             -- 'pending' | 'running' | 'done' | 'error'
  requested_by   uuid                      -- auth user, for the audit trail
  error          text
  created_at / started_at / ended_at timestamptz
```

RLS: both tables owner-scoped exactly like `character_fitting_over_time`
(select for owners; **all writes via service role only** — the browser never
holds the write path). The library is populated two ways: automatically, by a
sync step that upserts a library row for every fit the extract sees (so the
library is a superset of the game at all times, no user action needed to be
protected); and implicitly kept when a fit vanishes (the row just goes
non-resident instead of being forgotten — that's the whole point).

## The op state machine

All ESI writes happen in one new job, `fitting-pager` (`src/jobs/
fittingPager.js`), dispatched via the existing Vercel queue — **never from a
server component** (same rule as everywhere: UI → DB → job → ESI). One op per
message; per-character serialization by the same one-message-per-owner rule
the corp jobs use, so two ops can't race one character's 500-slot budget.

**page_out(library_id)** — the paranoid path, since DELETE is destructive:

1. Fresh `GET /fittings` (the conditional-request plumbing from #743).
2. Verify the live fit's normalized content matches the library row's
   `content_hash`. Mismatch → the fit was edited in the client since our last
   extract → update the library row from live _first_ (never delete a version
   we haven't stored), then continue.
3. `DELETE /characters/{id}/fittings/{fitting_id}`.
4. Mark the row `resident_fitting_id = null, evicted_at = now()`; op `done`.

The next `character-fittings` extract sees the fit gone and closes its SCD row
— that's correct and needs **no change to the extract**: the SCD table records
what the game reported; the library records what the player owns. The two
disagree exactly when a fit is paged out, by design.

**page_in(library_id)**:

1. Guard: resident count (from `character_fitting`) must be under the cap,
   minus a safety margin of 5 (the count is as stale as the last extract; the
   margin absorbs fits saved in the client since). Over → op fails with a
   "game is full — evict something" error the UI turns into a prompt.
2. Dedupe: if any resident fit matches `content_hash`, just re-attach
   (`resident_fitting_id` = that id) and finish — no POST.
3. `POST /characters/{id}/fittings` with the stored body; store the returned
   `fitting_id` as `resident_fitting_id`, clear `evicted_at`; op `done`.
4. Kick a `character-fittings` refresh for that character so the SCD table
   and `/fitting` converge immediately rather than at the next cron.

Idempotency: each op row is claimed by flipping `pending → running`; a retry
of a `running` page_in re-checks the content hash against live before ever
POSTing again, so a crash between POST and commit can't double-save a fit.

## The write scope is a different kind of ask

`esi-fittings.write_fittings.v1` would be this app's **first write scope** —
today every token is read-only and the UI never mutates the game. That line
is worth keeping visible:

- The scope gets a `scopes.ts` entry that is **excluded from the default
  request set** — unlike every existing scope, it's requested only when the
  player has explicitly enabled it in settings. This needs a small mechanics
  change: an `optIn: true` flag on `EsiScope` that keeps a scope out of
  `defaultScopes` (today `defaultScopes` is simply "all of them").
- Paging is additionally gated per character by a `user_settings` flag, so
  holding the scope alone never enables deletes.
- Every DELETE is preceded by the verify-then-store step above, and every op
  lands in `fitting_page_op` — a full audit trail of what we did to the
  player's game state and when.

## Eviction policy

**Phase one is manual only**: the player pages fits in and out explicitly
from `/fitting`. No automation touches the game.

Automatic eviction ("game is full, make room") is a deliberate afterthought,
because the OS analogy breaks down in one place: **there is no LRU signal.**
ESI doesn't report when a fit was last used, so "least recently used" is
unknowable. The best available victim ordering is:

1. never `pinned`,
2. oldest `resident-since` (the page-in time we do know, or `valid_from` for
   fits the extract discovered),
3. tie-break: hulls the character doesn't currently own (via
   `character_asset`) — a fit for a ship you don't have is a fair guess for
   cold.

Even then, auto-evict runs only as an explicit "make room and save" action
the player clicks, never in the background.

## UI (on `/fitting`)

- The matrix gains archived fits: a paged-out fit renders dimmed with a
  **restore** action; a resident fit gets **archive** (page out) and **pin**.
- A per-character meter — `487 / 500 saved on Philihp` — computed from
  `character_fitting`, with the same freshness caveat as everything else.
- Op status surfaces like "Refresh ESI" does: `fitting_page_op` rows are the
  `refresh_task` analogue, polled on the page while pending.

## Delivery order

1. **Tables + library sync** — migration for `fitting_library` /
   `fitting_page_op`; a sync step (in the extract or a tail of it) that
   upserts library rows from `character_fitting`. Read-only; ships value
   immediately (the library view can already show "you have 612 distinct fits,
   512 resident").
2. **Write scope + opt-in mechanics** — `optIn` flag in `scopes.ts`, settings
   toggle, per-character enable flag. Still no write path.
3. **The pager job** — `fitting-pager` + queue wiring + the op state machine,
   exercised by CLI first (`pnpm run fitting-pager`).
4. **UI** — matrix actions, the meter, op polling.
5. **(Optional) assisted eviction** — the "make room" flow above.

## Known risks and open questions

- **Cap detection is soft.** We learn the true count only as often as the
  extract runs; the safety margin papers over that but a player saving fits
  in-client mid-op can still hit the cap. The POST's failure (whatever status
  ESI returns at the cap — to be confirmed empirically on a test character)
  must be treated as a clean op failure, never retried blind.
- **Fitting content limits.** Name/description lengths and item counts are
  validated by ESI on POST; our stored rows came _from_ ESI so they should
  round-trip, but mutated/legacy rows might not. Op errors carry ESI's
  response body for exactly this.
- **Deleting the wrong thing is the nightmare case.** The verify-before-
  DELETE step and the append-only op log are non-negotiable; a dry-run mode
  (log the DELETE we would have done) ships first and stays available.
- **Scope revocation mid-flight.** A token that loses the write scope fails
  ops cleanly (`forEachCharacter` already re-checks scopes after refresh).
- **Multi-character libraries.** The library is per character (fits are
  per character in game). Cross-character copy ("save this fit to my alt") is
  a natural follow-up — it's just a page_in of another character's library
  row — but out of scope until the single-character loop is trusted.
