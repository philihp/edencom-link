# Plan: Marshal, Unmarshal and Transfer — moving fittings out of the 500-slot cap

**Revised 2026-10-16; all five PRs shipped the same day** — 1 (table and store),
2 (write path), 3 (web UI), 4 (the mount), 5 (GraphQL and MCP). The first
version of this plan merged on 2026-09-14 (#1038) and nothing in it was built. This revision re-reads it against the
codebase a month later. The objective has not moved: EVE lets a character keep
500 saved fittings, and a player should be able to **marshal** a fit out of
the game into our database, and **unmarshal** it back into the game later, on
whichever character they choose. What moved is around it — see "What a month
changed" below, which is the list of decisions that differ from the September
plan and why.

| Verb          | Where                                        | What it does                                                                  |
| ------------- | -------------------------------------------- | ----------------------------------------------------------------------------- |
| **Marshal**   | a fit the caller owns, saved in EVE          | keeps the fit here, deletes it from EVE. Frees one slot.                      |
| **Unmarshal** | a marshalled fit                             | saves the fit back into EVE, on a character the caller picks. Uses one slot.  |
| **Transfer**  | a fit the caller owns, saved in EVE          | saves the fit on a second character, then deletes it from the first.          |

Every verb has two interfaces, and this revision designs them together: a
button on the fitting pages, and a folder in the macOS FUSE mount
([`fitting-fuse.md`](fitting-fuse.md)). The FUSE client shipped the same two
ESI writes with the player's own disk as the archive. Here the archive is a
table in Supabase, so it survives a lost laptop, follows the account rather
than a character, and is readable from every surface the account has.

## What a month changed

The fitting code itself did not. `src/app/api/fittings/lib.ts`, the three
routes, the extract job, `/fitting` and its detail page have no commits since
the plan merged — every "read this first" statement below was re-verified
against the working tree, not carried over. The surroundings did change, and
these are the decisions that follow:

1. **The handle for a marshalled fit is its content hash, not a uuid.** The
   FUSE docs already establish that a fit's identity is `contentHash`
   (sha256 over the normalized body), that the game's `fitting_id` is a frame
   number, and that "the URI you wrote to is a URI you can read back". A
   content-addressed archive makes a `cp` into the mount idempotent, lets the
   client compute the handle without a round trip, and makes the table's
   natural key `(user_id, content_hash)` the primary key rather than a
   constraint beside a surrogate. The September plan's `id uuid` is gone.
2. **The FUSE mount is a first-class interface, not a follow-up.** The
   September plan said "an `Archive/` folder is a natural follow-up". The
   client is shipped and the owner wants it kept central, so the mount gains
   a `Marshalled/` folder at the top level, and `mv` between it and a
   character folder is marshal/unmarshal. That needs the client to implement
   `Rename` (today `EPERM`) and the API to grow one collection. Both are in
   the delivery order.
3. **The API stays thin: one new collection, one flag on an existing verb.**
   `/api/fittings/marshalled[/{hash}]` is the archive store, and it never
   touches ESI. Marshal is the existing `DELETE` with `?marshal=1`, so the
   body stored is the one ESI handed back at the moment of the delete. Unmarshal
   is the existing `PUT` restore, fed the archive file. Transfer is restore then
   delete, as before. Nothing in the client needs a verb the server did not
   already have, except the store itself.
4. **A marshalled fit can be deleted from the archive.** The September plan
   forbade it ("the point of the table is that nothing is lost"). With the
   mount in the design a folder you cannot `rm` from is wrong, and the
   recovery story does not depend on it: a fit that reached the archive
   through an ESI delete is in `fitting_write_log` forever, and one `cp`'d in
   from disk is still on that disk. The web page gets a `.danger` button for
   the same operation.
5. **Fittings are not in GraphQL, and the phone will only speak GraphQL.** The
   iOS plan merged 2026-10-05 ([`ios-app/`](ios-app/)) reads nothing but
   `/api/graphql`, and today that schema has no fittings type at all — so
   neither resident fits nor marshalled ones would reach the app, Links, CSV
   or MCP `run_query`. Putting the library into GraphQL is the right follow-up
   and is listed as PR 5, deliberately last: the web and FUSE interfaces do
   not depend on it.
6. **MCP write tools now have a precedent, and marshal still is not one.**
   `edit_watched_systems` shipped as the second write tool, with
   `destructiveHint: true`. The precedent lowers the bar for a write tool that
   touches our own tables; it does not lower it for one that deletes a
   player's in-game state on a model's say-so. `list_fittings` gains
   `include_marshalled` (read-only). No marshal tool.
7. **New UI follows the design system.** Since September the Structures,
   Industry and Account Settings pages were rebuilt from `docs/design-system/`
   mocks: panels with source tags, lowercase terse labels, one lavender
   `.primary` per view, the `Tag` component for states. The fitting pages
   predate it and still carry a `className="serif"` heading, a retired role.
   The new controls and the marshalled page use the system's idiom; the
   existing fitting pages are not restyled by this plan.
8. **The grant path is "re-auth", not "re-add".** `/account/registrations`
   now counts the characters whose grants lag the account's template and
   offers a per-character re-auth. The disabled-button hint for a character
   without the write scope links there. The error text in `esiToken()` still
   says "re-add the character"; PR 2 updates it.
9. **Write load is a settled concern.** [`db-write-load/`](db-write-load/)
   recorded the owner's decisions on the 14M-update asset touch. A marshal is
   one row per click per account, and the mirror's close is the same single
   update the extract would have made. Nothing here adds a per-run write.
10. **Privacy of the marshalled set.** The month's sharing work added
    account-wide place shares and the "show as main" owner mask, all built on
    the premise that nothing leaks which characters an account holds. A
    marshalled fit is account-level and carries its source character as
    provenance, so the marshalled page and the API answer only the owner —
    there is no share row, no public read, and the source character is shown
    only to the person who owns both.

## Read this first: what already exists (verified 2026-10-16)

- **The ESI write path.** `src/app/api/fittings/lib.ts` holds the only two ESI
  writes in the app: `archiveFitting` (fetch live, log, `DELETE`, close the
  local SCD row; returns the fit as ESI held it) and `restoreFitting` (refuse
  a used request id, fetch live, dedupe by content hash, refuse at 500 with
  `507`, log, `POST`, open the local SCD row). Both are correct for this
  feature without change. Marshal _is_ `archiveFitting` plus a store;
  Unmarshal _is_ `restoreFitting` plus a delete from the store; Transfer is
  the second followed by the first.
- **The audit trail.** `fitting_write_log` records the whole fit body before
  every ESI call, service-role write, owner read. Its `source` column
  carries `'fuse'` or `'api'` today; the comment reserves it for a future UI
  path, which is `'web'` below.
- **Identity.** `contentHash` in `src/fittingArchive.ts`: sha256 over the
  normalized `(ship_type_id, name, description, items)`, plain codepoint
  sort. `parseArchiveFitting` validates a file from someone's disk. Tested.
- **The write scope.** `esi-fittings.write_fittings.v1` is `optIn: true` in
  `src/app/character/scopes.ts`, so it is never requested unless the player
  turned it on under `/settings/grants`. `esiToken()` refuses with `403` when
  the character's token lacks it, and re-checks after refresh that EVE still
  recognizes it.
- **The mirror converges itself.** Both writes update
  `character_fitting_over_time` in the shape the extract would, so `/fitting`
  agrees immediately and the next `character-fittings` run (every 6h, ETag
  conditional) finds nothing to change. The extract needs no edit.
- **The FUSE client.** `fuse/` — Go over cgofuse. `internal/link` is the HTTP
  client (`List`, `Archive`, `Restore`), `internal/vfs` the tree (one `Dir` per
  character, one `File` per fit, sanitized and deduplicated names); both
  tested. `fs.go` translates kernel calls and returns `EPERM` for `Mkdir` and
  `Rename`. A restore happens on `Flush`; refusals map `507 → ENOSPC`,
  `400 → EINVAL`, `401/403 → EACCES`.
- **Caller resolution.** `authorize(request)` maps an `api_token` to a
  `Caller` (`{ supabase: service client, userId, registrations }`). Server
  actions on the fitting page (`actions.ts`) use the cookie-session client and
  prove ownership through RLS on `registration`. The generic `ShareDialog`
  takes bound server actions, a native `<dialog>` and `useTransition`.
- **Gates.** `establishedUser()` is the member check on every page; `/fitting`
  and the detail page use it already.

What does **not** exist is a place for a fit that is ours but not in the
game. `archiveFitting` closes the SCD row and the fit leaves `/fitting`; the
only copy on our side is the log row, and the log is an audit trail, not a
library.

## The marshalled fit is account-level, not character-level

A marshalled fit has no `fitting_id` (EVE deleted it) and no character (the
player picks one on unmarshal, and it need not be the one it came from). So
the row belongs to the **account**, keyed on `user_id` the way `link` and
`bpo_share` are, with the source character kept only as provenance. A player
about to unlink a character marshals its fits first, and the rows survive the
unlink (`on delete set null` on the provenance column).

### Table

```
marshalled_fitting
  user_id                uuid not null → auth.users(id) on delete cascade
  content_hash           text not null                 -- src/fittingArchive.ts contentHash; THE handle
  name                   text not null
  description            text not null default ''
  ship_type_id           bigint not null
  items                  jsonb not null default '[]'   -- normalized, POST-ready
  source_registration_id uuid → registration(id) on delete set null   -- provenance only
  source_fitting_id      bigint                                        -- the game id it had
  write_log_id           bigint → fitting_write_log(id)  -- the delete that marshalled it; null for a file cp'd in
  source                 text not null                   -- 'web' | 'fuse' | 'api', like fitting_write_log
  marshalled_at          timestamptz not null default now()
  primary key (user_id, content_hash)
```

- **`(user_id, content_hash)` is the primary key.** One archive row per
  distinct fit per account, and the hash is what every URL and path names.
  Marshalling the same fit from two alts deletes it from both and keeps one
  row; the second marshal updates `marshalled_at`, the source columns and
  `write_log_id` rather than failing, because the slot is still freed, which
  is what the player pressed the button for.
- `items` is stored already normalized (`normalizeItems`), so the row is the
  exact `POST` body and `contentHash` of the row equals its key. The API
  refuses a `PUT` whose body hashes to something other than the path.
- **RLS:** owner `select` on `user_id = (select auth.uid())`. **No `insert`,
  `update` or `delete` policy for `authenticated`.** Every write goes through
  the service role after the request has proved who it is — the `api_token`
  for the routes, the cookie session for the server actions — the same rule
  as `fitting_write_log`. A row must only appear beside a real ESI delete or
  a file the owner handed us.
- Written to `schema.sql` and to a migration from `pnpm run db:new
marshalled_fitting` (fresh timestamp from the clock, never copied).
- `test/sql/marshalled_fitting.sql`: owner reads own rows, cannot read another
  account's, cannot insert, update or delete as `authenticated`; the key
  holds; `on delete set null` keeps the row when its source registration goes.

### What stays out of the table

- `character_fitting_over_time` stays a pure mirror of ESI. No `resident`
  column, no reconcile change. The extract closes a vanished row today and
  keeps doing exactly that.
- `character_fitting_share` keys on `(registration_id, fitting_id)`. A
  marshalled fit has neither, and after unmarshal the fit has a new id, so a
  share cannot follow it. Marshal and Transfer **delete the fit's share row**
  and the confirm dialog says so. Sharing a marshalled fit is out of scope.
- No `fitting_id` on the row beyond provenance. Nothing keys on it after a
  delete.

## The API: `/api/fittings/marshalled`

Authenticated by `api_token` through `authorize()`, like the rest of the tree.
The handle is the content hash, 64 lowercase hex characters, so it cannot be
mistaken for a `fitting_id` (digits only) or a request id (uuid).

| Route                                                 | What it does                                                                                  |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `GET /api/fittings/marshalled`                        | every marshalled fit on the account, with `ship_name`, provenance and `marshalled_at`        |
| `GET /api/fittings/marshalled/{hash}`                 | one archive file: ESI's fitting object, nothing added                                          |
| `PUT /api/fittings/marshalled/{hash}`                 | store a fit in the archive **without touching ESI**; `400` if the body does not hash to `{hash}`; idempotent |
| `DELETE /api/fittings/marshalled/{hash}`              | remove it from the archive. Permanent; no ESI call                                            |
| `DELETE /api/fittings/{characterId}/{fittingId}?marshal=1` | the existing archive-delete, **also** storing the live body as a marshalled row. Answers the row's `content_hash` |

`PUT` is how a player moves their disk archive into Supabase (`cp
~/EVE/Archive/*.json ~/EVE/Fittings/Marshalled/`), and how `mv` into the
`Marshalled/` folder works when the source is another folder on disk. It
writes `source` from the `X-Edencom-Source` header as the other routes do.

`?marshal=1` on the existing `DELETE` is the marshal verb itself, server-side
and atomic from the caller's point of view: `archiveFitting` returns the fit
as ESI held it at the moment of the delete, and that body — not the mirror's
copy — is what the store receives. Without the flag `DELETE` behaves as it
does today, so the shipped client is unchanged until it is rebuilt.

`GET /api/fittings` (the listing) gains a `marshalled: [...]` array beside
`characters`, so the mount builds its whole tree from one response as it does
now.

## The write path: one refactor, three functions and a store

All in `src/app/api/fittings/lib.ts`, so the rule "every ESI write is in this
one file" still holds. The store functions are there too, because the marshal
flow is one function that calls both halves.

**Refactor `authorize` into two halves.** Split out
`callerForUser(userId): Promise<Caller>` and have `authorize` call it after
the token lookup. A server action that has already proved who is signed in
gets the same `Caller` the routes get, and `archiveFitting`/`restoreFitting`
do not change.

**`storeMarshalled(caller, fitting, provenance)` / `readMarshalled` /
`deleteMarshalled`** — the archive store over `marshalled_fitting`, upsert on
`(user_id, content_hash)`. No ESI. The routes above are thin wrappers.

**`marshalFitting(caller, registration, fittingId, source)`**

1. `archiveFitting(caller, registration, fittingId, source)`. This is the whole
   safety story: live fetch, log row first, `DELETE`, close the SCD row.
2. `storeMarshalled` from `archived` with `write_log_id` pointing at the
   delete's log row.
3. Delete the `character_fitting_share` row for `(registration_id, fittingId)`
   if there is one.
4. Return `{ content_hash }`.

If step 1 fails, nothing is stored. If step 2 fails after a successful delete,
the log row still holds the fit (`status = 'ok'`, `op = 'delete'`) and the
action reports the error; a Chancellor can replay the row by hand. That is the
recovery position the FUSE client is in today for every `rm`.

**`unmarshalFitting(caller, contentHash, registration, source)`**

1. `readMarshalled` scoped to `caller.userId`; `404` if absent.
2. `restoreFitting(caller, registration, crypto.randomUUID(), body, source)`.
   The request id is minted per call. `restoreFitting` already answers the
   existing `fitting_id` when the target holds the same content, and `507`
   when the target is full.
3. `deleteMarshalled`, after the restore, so a failed restore leaves the row.
4. Return `{ characterId, fitting_id, created }`.

**`transferFitting(caller, from, to, fittingId, source)`**

Order is the design. The copy is made **before** the original is removed, so
no failure can lose the fit:

1. `from` and `to` must both be the caller's and must differ.
2. Fetch `from`'s live library (`liveFittings`) and take the fit's current
   body — what ESI holds now, not the mirror's copy.
3. `restoreFitting(caller, to, randomUUID(), body, source)`.
4. `archiveFitting(caller, from, fittingId, source)`.
5. Delete `from`'s share row for the fit.

No `marshalled_fitting` row is involved. If step 3 fails, nothing happened. If
step 4 fails after step 3, the fit exists on both characters; the action
reports "saved on _B_, but EVE would not delete it from _A_" and links to the
original so the player can press Marshal on it. Safe and retryable, so it is
reported rather than rolled back. The reduction from the two step results to
the message and redirect is a pure function with a test.

Every failure the write functions already produce (`Failure` with a status
and message) comes back through the action's return value, never as a throw.
`esiToken()`'s `403` text changes from "re-add the character" to "re-auth it
on /account/registrations".

## Server actions

`src/app/fitting/marshalActions.ts` (`'use server'`), one action per verb,
following `actions.ts` next to it:

1. Cookie-session client; `establishedUser`.
2. Ownership: the registration ids named in the call must be among the
   caller's own `registration` rows (RLS proves it, as `ownFitting` does).
3. `callerForUser(user.id)` for the service-role `Caller`.
4. The lib function above with `source: 'web'`.
5. `revalidatePath('/fitting')` and the affected detail paths.

Synchronous like the routes: the player pressed a button and waits one or two
ESI round trips for the answer. Nothing is queued or dispatched to a job.

## Web UI

Design-system idiom throughout: lowercase terse labels, `Tag` for states, the
clickable-vs-readout rule from `globals.css` (outline buttons; one `.primary`
per view; `.danger` for the permanent delete), no new `.serif`.

### The detail page, own fit (`/fitting/[characterId]/[fittingId]`)

A `MarshalControls` client component in the existing `shareRow` beside
`ShareDialog`, rendered only when `owner.isOwn`. Whether the character holds
the write scope is read the way `account/registrations/matrixData.ts` reads
grants: `token.scope` through the service client, filtered to the caller's
RLS-proved registration ids, since `token` is not session-readable. Without
the scope the two buttons render disabled with the hint "grant _save and
delete fittings_, then re-auth on [registrations]".

- **marshal** — native `<dialog>` confirm: "Removes _name_ from _Pilot_'s
  saved fittings in EVE. The fit stays here, and any share of it ends." On
  success, `router.push` to the marshalled fit's page.
- **transfer** — `<dialog>` with a `<select>` of the caller's other characters
  that hold the write scope, each labelled with its slot count (`Alt Pilot ·
  412 / 500`), full characters disabled. On success, `router.push` to the
  fit's new URL on the target character.

Both use `useTransition` and bound server actions, the `ShareDialog` pattern.
Neither is `.primary`; the page's primary action stays the viewer.

### The marshalled fit page (`/fitting/marshalled/[hash]`)

A static segment beside `/fitting/[characterId]`, which Next resolves first;
`resolveFittingOwner` already rejects a non-numeric first segment, so nothing
collides. Owner-only (RLS on the table; no share path, no signed link). It
renders the same `ShipViewDynamic`, `SlotGroups` and `EftExport` as the
detail page — `toEsiFit` takes the marshal row as it takes a `FittingRow` —
with the all-V pilot baseline (no character holds it), under a line
"marshalled from _Pilot_ on _date_" (or "added from a file" when
`write_log_id` is null).

- **unmarshal** — the one `.primary` button on the page: the same character
  `<select>` with slot counts. On success, `router.push` to the restored fit.
- **delete from archive** — `.danger`, behind a confirm; the only way a
  marshalled fit leaves the account from the web.

### The library (`/fitting`)

- Marshalled fits join the matrix (`page.tsx` reads `marshalled_fitting`
  beside `character_fitting`), dimmed, with a `marshalled` Tag where a shared
  fit shows "shared by …", linking to the marshalled page. The owner `<select>`
  gains a "Marshalled" entry; entries carry a sentinel `ownerId` so the
  existing client-side filter works unchanged. `useOwnerFilter` persists its
  choice through `usePersist`, whose `parse` must accept the sentinel or a
  reload silently drops back to "All".
- A per-character slot meter in the header, `Pilot · 487 / 500`, computed from
  the `character_fitting` rows the page already loads. Freshness caveat as
  everywhere: as old as the last extract or the last write.

## The FUSE client

```
~/EVE/Fittings/
  Marshalled/                          ← marshalled_fitting, account-level
    Hurricane - Doctrine Cane.json
  Philihp Hallgren/                    ← the game's list, as today
    Rifter - Cheap Tackle.json
  Alt Pilot/
```

Every operation is a move or a copy, and the server call it maps to is one the
API has:

| Shell                                              | Kernel call                                  | API                                                                          |
| -------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------- |
| `mv "Pilot/x.json" Marshalled/`                    | `Rename` character → `Marshalled/`           | `DELETE …/{characterId}/{fittingId}?marshal=1`                               |
| `mv "Marshalled/x.json" Pilot/`                    | `Rename` `Marshalled/` → character           | `PUT …/{characterId}/{uuid}` with the file, then `DELETE …/marshalled/{hash}` |
| `mv "Pilot/x.json" Alt/`                           | `Rename` character → character               | `PUT` on the target, then `DELETE` on the source (the transfer order)        |
| `cp ~/EVE/Archive/x.json Marshalled/`              | `Create` + `Flush` in `Marshalled/`          | `PUT …/marshalled/{hash}` (hash computed client-side; no ESI)               |
| `rm Marshalled/x.json`                             | `Unlink` in `Marshalled/`                    | `DELETE …/marshalled/{hash}`                                                 |
| `cp Marshalled/x.json ~/EVE/Archive/`              | `Read`                                       | none; rendered from the listing like every file                              |

- `Rename` is implemented for exactly these three shapes and returns `EPERM`
  for anything else (a rename within one folder, or into the root). Not
  `EXDEV`, as first planned: `EXDEV` makes `mv` fall back to copy-then-unlink,
  and inside `Marshalled/` that is a `PUT` of the same content followed by a
  `DELETE` of it. `Mkdir` stays `EPERM`.
- A rename out of a character folder needs that character `writable`; one
  into a character folder needs the target `writable` and under 500, and a
  `507` still maps to `ENOSPC`.
- The `Marshalled/` listing has no `data_refreshed`: it is authoritative, not
  a mirror. `df` is unchanged (the archive has no cap).
- `internal/link` gains `ListMarshalled`, `PutMarshalled`, `DeleteMarshalled`
  and a `marshal` flag on `Archive`; `internal/vfs` gains the top-level
  `Marshalled` dir with the same sanitize/uniquify rules, keyed by hash. Both
  tested with `httptest` and table tests as today. `fs.go` only translates.
- `fuse/README.md` and [`fitting-fuse.md`](fitting-fuse.md) document the
  folder; the "will not do: rename, move" line is amended to the three moves
  above.

## Pure seams (tested with `node --test` and `go test`)

- `src/app/fitting/marshal/slots.ts` — `slotUsage(rows, ownCharacters)` →
  per-character `{ used, free, full }`, and `unmarshalTargets(...)` (the
  picker's order: emptiest first, full ones disabled). The number the whole
  feature exists for, so it gets the test.
- `src/app/fitting/marshal/entry.ts` — `marshalledEntry(row, ...)`: the matrix
  entry for a marshal row (href from the hash, sentinel owner, label).
- `src/app/fitting/marshal/route.ts` — `marshalledRoute(hash)`, pinned like
  `fittingRoute` is in `test/fittingRoute.test.ts`.
- The `transferFitting` outcome reduction in the lib, so the "saved on B but
  still on A" branch has a test without ESI.
- `parseMarshalledHandle` in the route file: 64 hex → hash, else not a handle.
- `fuse/internal/vfs`: the `Marshalled` dir in the tree; the rename
  classifier (which of the three moves a `(from, to)` pair is, or `EXDEV`).
- `fuse/internal/link`: the four new client calls against `httptest`.
- `test/sql/marshalled_fitting.sql` as above.

## What is deliberately not in this plan

- **No change to the extract job.** The mirror stays the mirror.
- **No auto-eviction, pins or LRU.** As [`fitting-paging.md`](fitting-paging.md)
  left them: ESI has no last-used signal, so eviction stays manual.
- **No MCP write tool.** `list_fittings` grows `include_marshalled`
  (read-only, PR 5). A `marshal_fitting` tool would delete in-game state from
  a model's call and is not proposed; an `unmarshal_fitting` tool spends only
  a slot and could follow `edit_watched_systems`'s shape later, if wanted.
- **No sharing of marshalled fits.** See above.
- **No restyle of the existing fitting pages.** The new pieces follow the
  design system; the matrix and detail page are as they are.

## Delivery order

Five PRs, each `pnpm run lint` + `pnpm test` + `pnpm run build`; PR 1 also
`pnpm run test:sql` against a throwaway database; PR 4 `make test` in `fuse/`.
PRs 3 and 4 both depend on 2 and are independent of each other.

1. **Table and store** — _shipped_ (migration `20261016004306_marshalled_fitting.sql`,
   `test/sql/marshalled_fitting.sql`, `test/marshalledHandle.test.ts`).
   `marshalled_fitting` in `schema.sql`, the migration,
   RLS, the SQL test; `storeMarshalled`/`readMarshalled`/`deleteMarshalled`
   in the lib; `GET`/`PUT`/`DELETE /api/fittings/marshalled[/{hash}]` and the
   `marshalled` array on the listing. No ESI involved, so it is testable with
   `curl` and useful on its own: a player's disk archive can move into
   Supabase from day one. This doc and the `docs/README.md` row.
2. **Write path** — _shipped_ (`marshalOutcome.ts`, `marshal/slots.ts` and their
   tests; actions in `src/app/fitting/marshalActions.ts`). `callerForUser`, `marshalFitting`, `unmarshalFitting`,
   `transferFitting`, `?marshal=1` on `DELETE`, the server actions, the pure
   seams and their tests, the `esiToken` message. Exercised from a scratch
   page or a test character; no UI.
3. **Web UI** — _shipped_ (`marshal/marshalControls.tsx`, `marshal/unmarshalControls.tsx`,
   `/fitting/marshalled/[hash]`, `marshal/entry.ts` + test, `marshal/targets.ts`).
   `MarshalControls` on the detail page, the marshalled page with
   unmarshal and delete, the library's marshalled entries and slot meter.
   Header and CLAUDE.md map entries.
4. **FUSE** — _shipped_ (`vfs.ContentHash`/`ParseFile`/`ClassifyRename`,
   `link.Marshal`/`PutMarshalled`/`DeleteMarshalled`, tested; `Rename` in
   `fs.go`; unsupported renames are `EPERM`, not `EXDEV` — see
   [`fitting-fuse.md`](fitting-fuse.md)). The `Marshalled/` folder, `Rename`, the client calls and their
   tests, `fuse/README.md` and `fitting-fuse.md`.
5. **Read surfaces** — _shipped_ (`fittingSummary.ts` + test, the schema
   drift test extended, MCP `include_marshalled`). `fittings` and `marshalledFittings` lists in GraphQL
   (session mode and `api_token` mode alike, own-data only), so Links, CSV,
   `run_query` and the planned iOS app can list the library; MCP
   `list_fittings` `include_marshalled`.

## Open questions

- **Should a FUSE `rm` in a character folder also marshal?** **Decided
  2026-10-16: no.** `rm` deletes, full stop — the write log is the only copy
  it leaves. Marshalling means getting a fit _out of ESI_ and onto disk or
  into Supabase, and on the mount that is a copy: `cp` to a folder on disk,
  or `mv` to `Marshalled/`. The two are not conflated, so a player who wants
  a fit gone keeps `rm` meaning exactly that.
- **Duplicate on unmarshal.** When the target already holds the same
  content, `restoreFitting` answers `created: false` with the existing id.
  The plan deletes the marshal row anyway, since the fit is in game. The
  alternative, keeping the row and telling the player, is a one-line change.
- **Should `PUT /marshalled/{hash}` accept a body whose hash differs?** No:
  `400`. A client that cannot compute the hash can `GET` the listing after a
  `?marshal=1` delete, and `cp` computes it from the file it holds. Accepting
  a mismatch would make the handle a label rather than an identity.
- **Which ESI status a full character returns to `POST`.** Unchanged:
  `restoreFitting` guards at 500 from the live count, so it matters only if a
  fit is saved in the client between the count and the `POST`; the `Failure`
  carries CCP's message either way.
