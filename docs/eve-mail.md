# Plan: EVE mail — a local copy of each character's mailbox, and the grant to send

**Planned 2026-10-20. All four PRs shipped:** PR 1 #1183, PR 3 #1184, PR 2
#1185 (2026-10-22), and PR 4, the MCP tools (see "The MCP tools" below). The
first mailbox was copied on 2026-10-24. Still owed: the one real send through
`pnpm run mail-send` that PR 3's verify step asks for (the owner's, by hand).

A quiet launch: no page on the site shows a mail, and no page sends one. What
ships is the two ESI grants, an extract job that keeps a copy of every
registered character's mailbox in Supabase, the one module that can send a
mail through ESI, the Registrations-page toggle that decides whether grants
that *change* game state are drawn at all, and the three MCP tools that read
and send mail through that module.

## Goal

1. A player can grant, per character, the ability to **read** their in-game
   mail and the ability to **send** mail as that character. Both are opt-in
   in the sense `EsiScope.optIn` already means: never requested unless the
   player turns them on.
2. Every mail the character can see — headers, bodies, labels, mailing
   lists — is copied into Supabase by an extract job in the per-character
   fan-out shape, and **stays there**: the point of the copy is that it
   outlives the in-game mailbox.
3. One server module can send a mail through ESI, logged before the call the
   way every fitting write is, so a later MCP `send_mail` tool is a thin
   wrapper and never the first place the write path is exercised.
4. On `/account/registrations`, a toggle in the header, left of
   **↻ Refresh all**, decides whether the matrix shows the grants that can
   change things in game. Today that is one column, **save/delete fits**;
   this plan adds a second, **mail**. Hidden by default.

## What ESI offers

The read side is three endpoints and the write side one, all under
`/latest`, all with the legacy `?token=` auth `src/esi.js` already speaks.
Pin the shapes to the live spec at implementation; what follows is the
reading this plan is built on.

| Call                                      | Scope                    | Shape                                                                                                                                                                                                                     |
| ----------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /characters/{id}/mail/`              | `esi-mail.read_mail.v1`  | The **50 newest** headers, newest first: `mail_id`, `from`, `subject`, `timestamp`, `is_read`, `labels[]`, `recipients[{ recipient_id, recipient_type }]`. `last_mail_id=` pages older; `labels=` filters. Cached 30 s.     |
| `GET /characters/{id}/mail/{mail_id}/`    | `esi-mail.read_mail.v1`  | One mail with its `body` (EVE markup: `<font>`, `<br>`, `<a href="showinfo:…">`), plus the header fields again. Cached 30 days. A mail deleted in the client answers 404.                                                   |
| `GET /characters/{id}/mail/labels/`       | `esi-mail.read_mail.v1`  | `labels[{ label_id, name, color, unread_count }]`, `total_unread_count`. Labels 1/2/4/8 are the client's Inbox/Sent/Corp/Alliance; higher ids are the player's own folders.                                                |
| `GET /characters/{id}/mail/lists/`        | `esi-mail.read_mail.v1`  | `[{ mailing_list_id, name }]` — the lists the character is on, which is the only way a `mailing_list` recipient id gets a name.                                                                                             |
| `POST /characters/{id}/mail/`             | `esi-mail.send_mail.v1`  | `{ subject, body, recipients[1..], approved_cost? }` → `201` with the new `mail_id` as the body. `recipient_type` ∈ `character`, `corporation`, `alliance`, `mailing_list`. Fails `520` when a recipient's CSPA charge exceeds `approved_cost`. |

Not requested: `esi-mail.organize_mail.v1` (mark read, relabel, delete). The
copy is read-only with respect to the mailbox; nothing here ever deletes or
re-files a mail in game.

Three facts shape the job:

- **Headers page backwards without a count.** There is no "how many mails"
  call; a backfill walks `last_mail_id` until a short page. A character with
  years of corp mail can hold thousands, so the first run is budgeted and
  resumed, not done in one step.
- **A header is frozen except `is_read` and `labels`.** Sender, subject,
  recipients and time never change, so the row is upserted in place like a
  contract's facts (`character_contract`), not versioned. The two mutable
  fields are overwritten on every sighting; we keep no history of when a
  mail was read.
- **A body is immutable and costs one call per mail.** Fetched once and
  stamped, the `items_fetched_at` pattern from contracts, with a per-run cap
  so a fresh grant drains over a few 6-hourly runs rather than firing a
  thousand requests in one step.

## Scopes and the matrix

### The two new `EsiScope` entries (`src/app/character/scopes.ts`)

Both carry `optIn: true`, so `defaultScopes` leaves them out and a player who
never touched `/settings/grants` is never asked for them. Copy in the voice
the fittings pair uses:

- `esi-mail.read_mail.v1` — **Read in-game mail.** _why:_ keeps a copy of
  this character's mail here — every header, body, label and mailing list —
  so it can be searched later and survives being deleted in game. _without:_
  this character's mail is not copied.
- `esi-mail.send_mail.v1` — **Send in-game mail.** _why:_ lets this site
  send an EVE mail as this character. Nothing on the site sends one today;
  this is the grant a later assistant tool will use, and every send is
  logged here in full before it goes. _without:_ no mail can be sent as this
  character. (PR 4 rewrote the _why_ once the tool existed: it lets an
  assistant connected to Aura MCP send a mail when the player asks it to.)

The `/settings/grants` page lists them with that copy as soon as PR 1 lands,
which is harmless: a grant with no job behind it does nothing until PR 2.

### One matrix column, two scopes, granted only when both are

The job column is `character-mail`, label **mail**, `section: 'character'`,
`kickable: 'always'`, `scopes: [read_mail, send_mail]`. Its template-row
checkbox requests both at once (that is what the user asked for: one toggle,
"Send/Receive in-game mail").

`columnGrant` today treats a multi-scope column as granted when **any** scope
is, because `character-status` runs whichever endpoints the token carries.
Mail is the other case: the job runs only on `read_mail`, and a token holding
only `send_mail` must not read as a ✓ over a cell that will say "never". So
`columnGrant` grows a fourth argument, `rule: 'any' | 'all'` (default
`'any'`, so nothing existing moves), carried on the entry as
`grantRule: 'all'`, tested in `test/registrationMatrix.test.ts`. The job
module itself asks `forEachCharacter` for `read_mail` alone.

### The toggle

A `changes: true` flag on the registry entry and on the `GrantColumn`
(`save/delete fits` gets it too) marks a column as "a grant that can change
game state". The page filters both lists through a pure
`changeColumns.ts` (`visibleJobColumns(entries, showChanges)`,
`visibleGrantColumns(columns, showChanges)`; tested) before anything is
counted or drawn, so `--cols`, the template row's "n of m", the ghost row
and the corporation matrix all follow. Trailing-scope and re-auth counts are
**not** filtered — a re-auth re-requests the whole template, so a hidden
column's missing grant still counts there, exactly as `trailingScopes`
reasons today.

Persistence follows the one precedent for a server-rendered column toggle,
`/indexes`'s **Manufacturing & reactions only** (`productionOnly.ts` +
`productionOnlyToggle.tsx`): a plain, not httpOnly cookie
`registrations_show_changes` (`'1'` = show; absent or anything else = hide;
400-day `Max-Age`), read in the server component with `cookies()` and written
client-side by the button, which then `router.refresh()`es in a transition.
The server render already draws the chosen columns, so there is no
hydration flash and no second column set to hide with CSS. Per-browser
rather than per-account on purpose: it is a view preference, and a
`user_settings` column for it would be a migration for something no other
surface reads. `registrationsShowChanges.ts` (constant, `parse`) +
`showChangesToggle.tsx` (`'use client'`), beside `matrixButtons.tsx`.

Placement and copy: in `.headerActions`, as the first child so it sits left
of **↻ Refresh all** (which renders only when there is a character; the toggle
renders always, since the template row exists before the first character).
Default outline button per the clickable-vs-readout rule, `aria-pressed`,
label **Show grants that change things** when off and **Hide grants that
change things** when on, title explaining that these grants let this site
change something in game rather than only read it.

## Data model

Four tables, all keyed on `registration_id` (the uuid, named correctly as the
fitting tables are), all owner-only under RLS, all written by the service
role. **No share table, no audience columns, no view for anyone but the
owner.** Mail is the most personal thing this database will hold; the
sharing layer does not apply, and a share model for mail is not a follow-up.

```sql
-- One row per mail the character can see. Facts frozen at delivery; is_read
-- and labels overwritten on every sighting; body filled once.
create table public.character_mail (
  registration_id  uuid   not null references public.registration(id) on delete cascade,
  mail_id          bigint not null,
  from_id          bigint not null,
  subject          text,
  sent_at          timestamptz not null,          -- ESI `timestamp`
  is_read          boolean not null default false,
  labels           bigint[] not null default '{}',
  recipients       jsonb   not null default '[]', -- [{ recipient_id, recipient_type }], sorted
  body             text,                          -- null until fetched; EVE markup kept verbatim
  body_fetched_at  timestamptz,                   -- set even when ESI 404s (body stays null)
  first_seen_at    timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  primary key (registration_id, mail_id)
);
create index character_mail_body_owed_idx
  on public.character_mail (registration_id, sent_at desc) where body_fetched_at is null;
create index character_mail_from_idx on public.character_mail (registration_id, from_id);
create index character_mail_sent_idx on public.character_mail (registration_id, sent_at desc);

create table public.character_mail_label (
  registration_id uuid not null references public.registration(id) on delete cascade,
  label_id        bigint not null,
  name            text,
  color           text,
  unread_count    integer,
  primary key (registration_id, label_id)
);

create table public.character_mailing_list (
  registration_id uuid not null references public.registration(id) on delete cascade,
  mailing_list_id bigint not null,
  name            text,
  primary key (registration_id, mailing_list_id)
);

-- Where the backwards header walk stands for one character.
create table public.character_mail_sync (
  registration_id   uuid primary key references public.registration(id) on delete cascade,
  oldest_mail_id    bigint,                       -- the smallest mail_id a page has shown
  backfill_complete boolean not null default false,
  updated_at        timestamptz not null default now()
);

-- Every mail this deployment asked ESI to send, written BEFORE the call.
create table public.mail_send_log (
  id              bigint generated always as identity primary key,
  user_id         uuid not null references auth.users(id) on delete cascade,
  registration_id uuid not null references public.registration(id) on delete cascade,
  request_id      uuid not null,                  -- caller-minted; used once (unique index), like fitting_write_log
  recipients      jsonb not null,
  subject         text not null,
  body            text not null,
  approved_cost   bigint not null default 0,
  mail_id         bigint,                         -- ESI's answer; null until it answers, and on error
  source          text not null default 'cli',    -- 'cli' | 'mcp' | 'web' as callers arrive
  status          text not null check (status in ('pending', 'ok', 'error')),
  error           text,
  created_at      timestamptz not null default now(),
  finished_at     timestamptz
);
create unique index mail_send_log_request_id_idx on public.mail_send_log (request_id);
create index mail_send_log_registration_idx on public.mail_send_log (registration_id, created_at desc);
```

RLS on every table: `select` to `authenticated` where `registration_id in
(select id from registration where user_id = auth.uid())` (the
`character_fitting_over_time` policy, verbatim), `mail_send_log` on
`user_id = auth.uid()`; `grant all … to service_role`. No `anon` grant
anywhere. `test/sql/character_mail.sql` proves: owner reads their rows, a
second account reads none, `anon` reads none, `authenticated` cannot insert
or update, a reused `request_id` is refused by the index.

Decisions worth stating:

- **Never deleted, never versioned.** A mail deleted in the client vanishes
  from the listing; we do not notice and do not care — the copy is the
  feature. (A full re-walk to detect deletions would cost the whole mailbox
  in headers every run; not worth it for a flag nothing reads.) The one
  cascade is the registration's: removing a character from the account
  removes its data, consistent with every other `character_*` table.
- **Names are resolved at read time, ids are stored.** `from_id` and
  recipient ids resolve through `universe_name` / `character_directory`
  (characters, corporations, alliances) and `character_mailing_list` (lists)
  when something displays them. The job calls `resolveBatch` (best-effort,
  like `resolveAssetStationNames`) over the new sender and recipient ids
  each run so `universe_name` has them by the time an MCP tool asks;
  mailing-list ids are skipped there since `universe/names` does not know
  them.
- **`recipients` is jsonb, sorted** by `(recipient_type, recipient_id)` in
  the pure mapper, so two sightings compare equal — small, read whole, never
  joined against, the `character_fitting_over_time.items` reasoning.
- **Bodies keep EVE's markup verbatim.** Stripping it is a presentation
  decision for whichever surface shows a mail; a stored body that cannot be
  round-tripped into a quoted reply would be a loss.
- `schema.sql` gets the four tables and a non-destructive migration under
  `supabase/migrations/` with a timestamp from the clock (`pnpm run db:new
  character_mail`), per the Workflow rules.

## The extract job: `character-mail`

`src/jobs/characterMail.js` exporting `runCharacterMail({ registrationIds })`,
`SCOPE = 'esi-mail.read_mail.v1'`, `cli(import.meta.url, …)`. Per character,
inside `forEachCharacter` (token refresh, heartbeats and the five-minute rule
come free):

1. **Newest headers, conditionally.** `GET /mail/` for the first page through
   `esiConditionalJson` with the stored ETag (`character-mail:<registration
   uuid>` in `esi_etag`). A `304` means nothing new and no read-state change
   among the 50 newest, the common case; skip to step 3 (the body backlog
   may still be owed from an earlier run). On `200`, upsert the page in place
   on `(registration_id, mail_id)` and store the ETag **after** the write.
   Then keep paging newer-to-older with `last_mail_id` until a page is all
   mails we already hold — that catches a burst of more than 50 since the
   last run.
2. **Backfill, budgeted.** While `character_mail_sync.backfill_complete` is
   false, continue from `oldest_mail_id` for up to `MAX_HEADER_PAGES` (20 →
   1,000 headers) per run, updating `oldest_mail_id` after each page; a short
   or empty page marks the backfill complete. A new grant therefore has its
   whole mailbox within a day or two of 6-hourly runs, oldest last.
3. **Bodies, up to `MAX_BODY_FETCHES` (100) per run,** newest first, over
   the `body_owed` partial index. Each `GET /mail/{id}/` fills `body` (and
   refreshes `is_read`/`labels`, since the response carries them); a tolerated
   `404` stamps `body_fetched_at` with `body` null so a mail deleted between
   listing and fetch is never retried forever. One failure is logged and
   skipped, not fatal to the character (the contract-items shape).
4. **Labels and lists,** two cheap calls, upserted in place; a label or list
   that disappears is left (nothing reads them to decide anything).

Pure seams in `src/jobs/mailFields.js` (tested): `mailHeaderRow(header,
seenAt)`, `mailBodyPatch(mail, fetchedAt)`, `normalizeRecipients`,
`labelRow`, `mailingListRow`, and `walkPlan` — given the ids a page returned
and the ids already held, says whether to fetch another page and from which
`last_mail_id`. `recordEsiConditional` per header request, as the fittings
job does.

Plumbing, each a one-line sibling of the fittings job's: `src/workflows/
characterMail.ts` (copy `characterFittings.ts`; `SCOPES = [read_mail]`, four
lanes), `src/app/api/cron/character-mail/route.ts`, a `vercel.json` cron
every 6 h at a minute no other entry uses, `"character-mail": "node
src/jobs/characterMail.js"` in `package.json`, `'character-mail'` in
`PER_CHARACTER_JOBS` (`dispatchRefresh.ts`) and the `JOB_WORKFLOWS` map, and
the registry entry above. The job must honour its budgets within a step's
duration (1,000 headers is 20 calls; 100 bodies is 100 calls at ESI's pace —
fine, but the caps are the knobs if a step ever runs long).

## The send path

`src/app/mail/lib.ts` — server-only, the second ESI write path after
`src/app/api/fittings/lib.ts`, and built the same way:

```ts
sendMail(caller: Caller, registrationId: string, draft: MailDraft): Promise<SendOutcome>
// MailDraft = { requestId: uuid, recipients: Recipient[], subject, body, approvedCost?: number }
```

1. Validate with the pure `src/mailCompose.ts` (tested): the registration is
   the caller's; 1–50 recipients (the live spec's `maxItems`), each a known `recipient_type` and a
   positive id; subject ≤ 1,000 and body ≤ 10,000 characters (the spec's
   limits — pin them from the spec, not from here); `approvedCost` a
   non-negative integer, default 0.
2. Insert the `mail_send_log` row `pending` with the whole draft. A reused
   `request_id` fails on the unique index → `409`, before anything reaches
   ESI (the `fitting_write_log` idempotency story, so an MCP client that lost
   a response can retry without sending twice).
3. `selectToken(registration_id, [send_mail])` + `refreshAccessToken`, then
   `esi.js` `sendMail(access_token, characterID, body)` — a `POST` through
   `esiJson`, returning the integer `mail_id`. The new function joins
   `createFitting`/`deleteFitting` as the third call in `esi.js` that changes
   a character's game state, and the file's comment says so.
4. Update the log `ok` with `mail_id` (or `error` with ESI's message — a
   CSPA `520` is reported, **never** retried with a higher `approved_cost`;
   spending the player's ISK is a decision only a caller can make
   explicitly). The sent mail reaches `character_mail` on the next extract
   through the Sent label, so the module writes nothing there itself.

Nothing on the site calls it in this plan. To prove the path end to end the
owner gets `pnpm run mail-send` (`src/mailSend.js`, beside `connect`/`ping`;
takes a registration, recipient, subject and body from flags, mints the
request id, prints the log row), used once against their own character. The
MCP `send_mail` tool is the intended caller and is PR 4.

## The MCP tools (PR 4, as built)

`src/app/api/mcp/mailTools.ts`, registered last in `route.ts`. Pure seams
`mailQuery.ts` (beside it) and `src/mailText.ts`, both tested
(`test/mailQuery.test.ts`, `test/mailText.test.ts`). The skill doc
(`docs/edencom-industry-SKILL.md`) has an "EVE mail" section with the send
procedure, and `/mcp-server` lists the three tools.

- **`list_mail`** — headers only, newest first, on the caller's bearer
  client. Filters AND together: `character` (name, EVE id or substring of
  the caller's own), `label` (Inbox / Sent / Corp / Alliance by fixed id,
  brackets optional; a player's own label by name, resolved to its id on
  each character, since the same name is a different id on each alt — sent
  as one PostgREST `or` of `and(registration_id, labels cs {id})` pairs),
  `from` (EVE id, or a name substring over `universe_name`,
  `character_directory` and the caller's mailing lists, refused past 100
  senders), `subject` and `body` substrings, `since`/`until`, `unread_only`,
  `limit` (50, at most 200). Copies of one mail on several alts are listed
  once with every character in `characters`; `is_read` is true only when
  every copy is. The answer carries `coverage` per extracted character (the
  oldest mail held, `backfill_complete`, `bodies_pending`) and
  `no_mail_copy` for the characters with no sync row, so a model can tell
  "no such mail" from "not copied yet".
- **`read_mail`** — up to 20 `mail_ids`, bearer client, the body from
  whichever copy holds one, as plain text (`mailText`: `<br>` to newlines,
  tags dropped, a web link keeping its address, entities decoded once) or
  `raw_markup`. `body_state` is `copied`, `pending` (not fetched yet) or
  `deleted` (ESI's 404).
- **`send_mail`** — `character`, `recipients` (each an exact name, or an EVE
  id with an optional type), `subject`, `body`, `body_format` (`text`, the
  default: `&`/`<`/`>` escaped and newlines to `<br>`, since the client shows
  no bare newline; `eve_markup`: as written), `approved_cost` (default 0),
  `request_id` (minted when absent, and returned), `preview`. A name resolves
  only to an exact, case-insensitive hit in the caller's own characters,
  `character_directory`, `universe_name` (character / corporation /
  alliance), `corporation`, `alliance`, or the **sender's** mailing lists; a
  name that is two things is refused until a type picks one, and an unknown
  name asks for the id. `preview` resolves and validates (`validateDraft`
  plus the token's scope, via `sendGrantHeld`) and sends nothing; its
  `request_id` is meant to be passed to the real send. The send itself is
  `sendMail(caller, registrationId, draft, 'mcp')`.

Three departures from the sketch in the delivery table:

- **The send runs on the service role.** The sketch put all three tools on
  the bearer client, but the send path reads `token`, which only the service
  role does here. So the reads stay on the bearer and `send_mail` takes
  `callerForUser(userId)` with the user id from the verified bearer — the
  shape `src/app/fitting/marshalActions.ts` uses with a cookie session. The
  privacy rule below is amended to say so.
- **`idempotentHint: false`**, not `true`. A `request_id` makes a retry safe,
  but the tool cannot require one: a model asked for a uuid too often types
  a well-known example one, and since the index is global, a collision
  would refuse a stranger's send. Without one, a repeat sends
  again, so the honest hint is false.
- **`openWorldHint: true`**, not `false`. The hint is about whether a tool
  reaches outside the deployment's own world, and a sent mail lands in other
  players' mailboxes.

## Privacy

- Owner-only RLS, service-role writes, no `anon` grant, no share model, no
  GraphQL field, no CSV route, no card, no page — in this plan and as a
  stated rule for the follow-ups: a mail surface reads through the owner's
  bearer or cookie session, never the service role on their behalf. The one
  exception is the send, which needs the token: it runs on the service-role
  Caller of the user the bearer or session proved, scoped by hand to that
  user's registrations, and writes only `mail_send_log`.
- The Chancellor account debug dump (`/account/settings/chancellor`) must not
  include mail tables. Impersonation reaches whatever the impersonated
  session reaches; that is the existing rule and this plan does not widen it,
  but PR 2 adds the exclusion to the dump explicitly.
- `mail_send_log` is the audit trail and is the owner's to read.

## Delivery order

| PR | Lands                                                                                                                                                                                                                                                           | Verify                                                                                                                          |
| -- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1  | The two `EsiScope` entries (opt-in). `changes` on `JobEntry`/`GrantColumn`, `save/delete fits` flagged. `changeColumns.ts` + `registrationsShowChanges.ts` + `showChangesToggle.tsx`; the page filters through them; cookie read/write. `columnGrant` `rule`. | `pnpm test` (new `changeColumns`, extended `registrationMatrix`); `build`+`lint`; the column hides/shows and `--cols` follows. |
| 2  | Schema + migration for the four tables; `mailFields.js`; `characterMail.js`; workflow, cron route, `vercel.json`, `package.json`, `PER_CHARACTER_JOBS`, registry entry (`changes: true`, `grantRule: 'all'`); `resolveBatch` of sender ids; dump exclusion.      | `pnpm test` (`mailFields`); `test:sql` (`character_mail.sql`); grant on one character, run the CLI, watch the matrix cell.      |
| 3  | `mail_send_log`; `esi.js` `sendMail`; `mailCompose.ts`; `src/app/mail/lib.ts`; `pnpm run mail-send`.                                                                                                                                                             | `pnpm test` (`mailCompose`); one real send to the owner's own alt; the log row flips `pending → ok`; the extract picks it up.   |
| 4  | _Shipped; see "The MCP tools" for what changed from this sketch._ MCP `list_mail` (label / sender / since / unread / subject filters over `character_mail`, names resolved, bodies only on request or by id), `read_mail(mail_id)`, `send_mail(draft)` — on the caller's bearer client, `send_mail` with `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: true` (the request id), `openWorldHint: false` (ESI is CCP, not a third party — but say so in the description). | the skill doc gains a mail section; the tool refuses a draft that fails `mailCompose`.                                           |

All four shipped. PRs 1 and 2 were independent of each other; 3 needed 2's migration only for
`mail_send_log` (fold it into 2's migration if they land together, else a
fresh timestamp). CLAUDE.md's table and job lists, and `docs/README.md`,
update with each PR.

## Decisions (were open questions, settled 2026-10-24)

- **Schedule: 6 h.** It matches the other per-character jobs. Mail that has
  to be read within minutes (a later notification) would need hourly runs;
  the ETag makes the no-change case nearly free, so hourly stays cheap if a
  feature ever needs it. Nothing does yet.
- **Backfill depth: everything.** The first mailbox reached back almost two
  years in one run of 21 pages, and the budget already spreads the rest over a few
  runs. No `sent_at` cutoff.
- **Corp and alliance mail: one copy per character, no shared table.** Three
  registered corpmates each hold a copy under their own `registration_id`.
  The one reader across characters, `list_mail`, folds the copies of one mail
  id on one account into one entry in its answer; a shared table keyed on
  `mail_id` would only pay off for a reader across accounts, and mail has no
  such reader by rule (see Privacy).
- **Body backlog: `MAX_BODY_FETCHES` stays 100.** A new grant copies 1,000
  headers per run but 100 bodies, so the bodies trail the headers by days,
  and a mail deleted in game before its body is fetched keeps only its
  header (`body_state: deleted`). Raise the cap if that loss is ever seen.
