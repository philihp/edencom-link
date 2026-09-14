# Plan: Marshal, Unmarshal and Transfer — moving fittings out of the 500-slot cap

EVE lets a character keep 500 saved fittings. This plan adds three buttons to
the fitting pages so a player can stay under that cap from the site itself:

| Button        | Where                                       | What it does                                                             |
| ------------- | ------------------------------------------- | ------------------------------------------------------------------------ |
| **Marshal**   | a fit the caller owns, saved in EVE         | keeps the fit here, deletes it from EVE. Frees one slot.                 |
| **Unmarshal** | a marshalled fit                            | saves the fit back into EVE, on a character the caller picks. Uses one slot. |
| **Transfer**  | a fit the caller owns, saved in EVE         | saves the fit on a second character, then deletes it from the first.     |

[`fitting-fuse.md`](fitting-fuse.md) shipped the same two ESI writes behind a
macOS FUSE mount. There the player's own disk is the archive. Here the archive
is a table in our database, and the interface is a button. Everything that
touches ESI is reused as it is; the new work is a table, three server actions,
and three pieces of UI.

## Read this first: what already exists

- **The ESI write path.** `src/app/api/fittings/lib.ts` holds the only two
  ESI writes in the app: `archiveFitting` (fetch live, log, `DELETE`, close the
  local SCD row) and `restoreFitting` (refuse a used request id, fetch live,
  dedupe by content hash, refuse at 500, log, `POST`, open the local SCD row).
  Both are correct for this feature without change. Marshal _is_
  `archiveFitting`. Unmarshal _is_ `restoreFitting`. Transfer is the second
  followed by the first.
- **The audit trail.** `fitting_write_log` records the whole fit body before
  every ESI call. That guarantee carries over unchanged.
- **Identity.** `contentHash` in `src/fittingArchive.ts` is the durable identity
  of a fit. The game's `fitting_id` is reassigned on every restore, so nothing
  in this plan keys on it after a delete.
- **The write scope.** `esi-fittings.write_fittings.v1` is opt-in
  (`optIn: true` in `src/app/character/scopes.ts`). `esiToken()` refuses with a
  clear 403 when a character has not granted it. The buttons render only for
  characters that hold it.
- **The mirror converges itself.** Both writes update
  `character_fitting_over_time` in the shape the extract would, so `/fitting`
  agrees immediately and the next `character-fittings` run finds nothing to
  change. The extract job needs no edit.

What does **not** exist yet is a place for a fit that is ours but not in the
game. Today `archiveFitting` closes the SCD row and the fit leaves `/fitting`.
The only copy left on our side is the log row, and the log is an audit trail,
not a library.

## The marshalled fit is account-level, not character-level

A marshalled fit has no `fitting_id` (EVE deleted it) and no character (the
player will choose one on unmarshal, and it need not be the one it came from).
So the row belongs to the **account**, keyed on `user_id` the way `link` and
`bpo_share` are, with the source character kept only as provenance. This is
what makes the feature useful for a player about to unlink a character: marshal
its fits first, and the rows survive the unlink.

### Table

```
marshalled_fitting
  id                     uuid pk default gen_random_uuid()
  user_id                uuid not null → auth.users(id) on delete cascade
  source_registration_id uuid → registration(id) on delete set null   -- provenance only
  source_fitting_id      bigint                                        -- the game id it had
  name                   text not null
  description            text not null default ''
  ship_type_id           bigint not null
  items                  jsonb not null default '[]'   -- normalized, POST-ready
  content_hash           text not null                 -- src/fittingArchive.ts contentHash
  write_log_id           bigint → fitting_write_log(id)  -- the delete that marshalled it
  marshalled_at          timestamptz not null default now()
  unique (user_id, content_hash)
```

- `unique (user_id, content_hash)`: one archive row per distinct fit per
  account. Marshalling the same fit from two alts deletes it from both and
  keeps one row. The second marshal updates `marshalled_at` and the source
  columns rather than failing; the slot is still freed, which is what the
  player pressed the button for.
- `items` is stored already normalized (`normalizeItems`), so the row is the
  exact `POST` body and `contentHash` of the row equals the stored hash.
- **RLS:** owner `select` on `user_id = auth.uid()`. **No `insert`, `update` or
  `delete` policy for `authenticated`.** A row must only appear next to a real
  ESI delete, so the server action writes it through the service role after
  the cookie session has proved ownership. Same rule as `fitting_write_log`.
- Written to `schema.sql` and to a new migration from `pnpm run db:new
marshalled_fitting` (fresh timestamp, never copied).
- `test/sql/marshalled_fitting.sql`: owner reads own rows, cannot read another
  account's, cannot insert or delete as `authenticated`; the unique key holds.

### What stays out of the table

- `character_fitting_over_time` stays a pure mirror of ESI. No `resident`
  column, no reconcile change. The extract closes a vanished row today and
  keeps doing exactly that.
- `character_fitting_share` keys on `(registration_id, fitting_id)`. A
  marshalled fit has neither, so a share cannot follow it, and after unmarshal
  the fit has a new id. Marshal and Transfer therefore **delete the fit's
  share row** and the confirm dialog says so. Sharing a marshalled fit is out of
  scope.

## The write path: one refactor, three functions

All in `src/app/api/fittings/lib.ts`, so the rule "every ESI write is in this
one file" still holds.

**Refactor `authorize` into two halves.** Today it maps an `api_token` to a
`Caller` (`{ supabase, userId, registrations }`). Split out
`callerForUser(userId): Promise<Caller>` and have `authorize` call it. A server
action that has already proved who is signed in gets the same `Caller` the API
routes get, and `archiveFitting`/`restoreFitting` do not change.

**`marshalFitting(caller, registration, fittingId)`**

1. `archiveFitting(caller, registration, fittingId, 'web')`. This is the whole
   safety story: live fetch, log row first, `DELETE`, close the SCD row. The
   `source` value `'web'` is new; the column's comment already reserved it for
   a UI path.
2. Upsert the `marshalled_fitting` row from `archived` (the fit as ESI held it
   at the moment of the delete, not the mirror's copy), on conflict
   `(user_id, content_hash)`.
3. Delete the `character_fitting_share` row for `(registration_id, fittingId)`
   if there is one.
4. Return the marshal row id, for the redirect.

If step 1 fails, nothing is inserted. If step 2 fails after a successful
delete, the log row still holds the fit (`status = 'ok'`, `op = 'delete'`) and
the action reports the error; a Chancellor can replay the row by hand. This is
the same recovery position the FUSE client is in today.

**`unmarshalFitting(caller, marshalId, registration)`**

1. Read the marshal row, scoped to `caller.userId`.
2. `restoreFitting(caller, registration, crypto.randomUUID(), body, 'web')`. The
   request id is minted per click. `restoreFitting` already returns the
   existing `fitting_id` when the target holds the same content, and 507 when
   the target is full.
3. Delete the marshal row. Done after the restore, so a failed restore leaves
   the row in place.
4. Return `{ characterId, fitting_id }` for the redirect.

**`transferFitting(caller, from, to, fittingId)`**

Order is the design. The copy is made **before** the original is removed, so
no failure can lose the fit:

1. `from` and `to` must both be the caller's and must differ.
2. Fetch `from`'s live library (`liveFittings`) and take the fit's current body.
   Copy what ESI holds now, not the mirror's copy, for the same reason
   `archiveFitting` verifies live.
3. `restoreFitting(caller, to, randomUUID(), body, 'web')`.
4. `archiveFitting(caller, from, fittingId, 'web')`.
5. Delete `from`'s share row for the fit.

No `marshalled_fitting` row is involved. If step 3 fails, nothing happened. If
step 4 fails after step 3, the fit exists on both characters; the action
reports "saved on _B_, but EVE would not delete it from _A_" and links to the
original so the player can press Marshal on it. That state is safe and
retryable, so it is reported rather than rolled back.

Every failure the write functions already produce (`Failure` with a status and
message) comes back through the action's return value, never as a throw.

## Server actions

`src/app/fitting/marshalActions.ts` (`'use server'`), one action per button,
following `actions.ts` next to it:

1. Cookie-session client; `establishedUser`.
2. Ownership: the registration ids named in the call must be in the caller's
   own `registration` rows (RLS proves it, as `ownFitting` in `actions.ts`
   does today).
3. `callerForUser(user.id)` for the service-role `Caller`.
4. The lib function above.
5. `revalidatePath('/fitting')` and the affected detail paths.

The actions are synchronous like the API routes: the player pressed a button
and waits one or two ESI round trips for the answer. This is the one place the
app writes to ESI from a request, already established by `/api/fittings`, and
it stays inside the same lib. Nothing here is queued or dispatched to a job.

## UI

### The detail page, own fit (`/fitting/[characterId]/[fittingId]`)

A `MarshalControls` client component next to `ShareDialog`, rendered only when
`owner.isOwn` **and** the character holds the write scope. Scope is read the way
`account/registrations/matrixData.ts` reads it: `token.scope` through the
service client, filtered to the caller's RLS-proved registration ids, because
`token` is not readable by a session.

- **Marshal** — native `<dialog>` confirm: "Removes _name_ from _Pilot_'s saved
  fittings in EVE. The fit stays here, and any share of it ends." On success,
  `router.push` to the marshalled fit's page.
- **Transfer** — `<dialog>` with a `<select>` of the caller's other characters
  that hold the write scope, each labelled with its slot count (`Alt Pilot —
  412 / 500`), full characters disabled. On success, `router.push` to the fit's
  new URL on the target character.

Both use `useTransition` and bound server actions, the `ShareDialog` pattern.
Outline buttons (the clickable-vs-readout rule in `globals.css`); neither is
`.primary`, since the page's primary action stays the viewer.

### The marshalled fit page (`/fitting/marshalled/[marshalId]`)

A static segment beside `/fitting/[characterId]`, which Next resolves first.
`resolveFittingOwner` already rejects non-numeric ids, so nothing collides.
Owner-only (RLS on the table; no sharing). It renders the same
`ShipViewDynamic`, `SlotGroups` and `EftExport` as the detail page — `toEsiFit`
takes the marshal row as it takes a `FittingRow` — under a "Marshalled from
_Pilot_ on _date_" line.

- **Unmarshal** — the one `.primary` button on the page: the same character
  `<select>` with slot counts. On success, `router.push` to the restored fit.

### The library (`/fitting`)

- Marshalled fits join the matrix (`page.tsx` reads `marshalled_fitting`
  alongside `character_fitting`), dimmed, with a "marshalled" tag where a
  shared fit shows "shared by …", linking to the marshalled page. The owner
  `<select>` gains a "Marshalled" option; the entries carry a sentinel
  `ownerId` so the existing client-side filter works unchanged.
- A per-character slot meter in the header, `Pilot 487 / 500`, computed from
  the `character_fitting` rows the page already loads. Freshness caveat as
  everywhere: as old as the last extract or the last write.

### Pure seams (tested with `node --test`)

- `src/app/fitting/marshal/slots.ts` — `slotUsage(rows, ownCharacters)` →
  per-character `{ used, free, full }`, and `unmarshalTargets(...)` (the
  picker's ordering: emptiest first, full ones disabled). This is the number
  the whole feature exists for, so it gets the test.
- `src/app/fitting/marshal/entry.ts` — `marshalledEntry(row, ...)`: the matrix
  entry for a marshal row (href, sentinel owner, label).
- The `transferFitting` outcome reduction — given the two step results, which
  message and which redirect — as a pure function in the lib, so the
  "saved on B but still on A" branch has a test without ESI.

## What is deliberately not in this plan

- **No FUSE change.** The mount is the game's list, so marshalled fits do not
  appear in `GET /api/fittings`. A FUSE `rm` keeps writing `source = 'fuse'`
  and does not create a marshal row: the player's disk is that path's archive.
  An `Archive/` folder over `marshalled_fitting` is a natural follow-up.
- **No permanent delete** of a marshalled fit. The point of the table is that
  nothing is lost. If wanted later it is one owner-only `delete` policy and a
  `.danger` button.
- **No auto-eviction, pins or LRU.** Still as `fitting-paging.md` left them:
  there is no last-used signal in ESI, so eviction stays manual.
- **No MCP tool.** `list_fittings` could grow `include_marshalled`; a
  `marshal_fitting` tool would be the third MCP write tool and needs its own
  decision.
- **No sharing of marshalled fits.** See above.

## Delivery order

Three PRs, each `pnpm run lint` + `pnpm test` + `pnpm run build`; the first
also `pnpm run test:sql` against a throwaway database.

1. **Table.** `marshalled_fitting` in `schema.sql`, the migration, RLS, the SQL
   test, this doc. Nothing reads it yet.
2. **Write path.** `callerForUser`, `marshalFitting`, `unmarshalFitting`,
   `transferFitting`, the server actions, the pure seams and their tests. No
   UI; exercised by calling the actions from a scratch page or a test
   character.
3. **UI.** `MarshalControls` on the detail page, the marshalled page with
   Unmarshal, the library's marshalled entries and slot meter. Header and
   CLAUDE.md map entries.

## Open questions

- **Should a FUSE `rm` also marshal?** Recommended no (above): the FUSE client
  already keeps a copy on disk, and a row per `rm` would fill the table with
  fits the player archived elsewhere on purpose. Easy to flip later: it is one
  upsert inside `archiveFitting` behind a `source` check.
- **Duplicate on unmarshal.** When the target already holds the same content,
  `restoreFitting` answers `created: false` with the existing id. The plan
  clears the marshal row anyway, since the fit is in game. The alternative,
  keeping the row and telling the player, is a one-line change if the first
  behaviour surprises anyone.
- **Which ESI status a full character returns to `POST`.** `restoreFitting`
  guards at 500 from the live count before calling CCP, so the question only
  matters if a fit is saved in the client between the count and the `POST`.
  The `Failure` from `createFitting` carries CCP's message either way.
