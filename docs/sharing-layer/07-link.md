# Phase 7: Links — shared queries in the creator's context

**Status: ✅ done** — migration `20260806130000_link.sql`, `/link` editor
(flag `link`), `/link/[id]` viewer, `/link/[id]/csv`, `runLink` over
`contextForUser()` (factored out of `src/app/api/graphql/context.ts`),
save-time validation in `src/app/link/validate.ts`, CSV flattening in
`src/app/link/flatten.ts`; covered by `test/linkValidate.test.ts`,
`test/linkFlatten.test.ts`, `test/sql/link.sql`. One deviation from the
sketch below, found while building: because the link row IS the share row,
the Revision 3 "empty audience = public" reading would have made a freshly
created link public — the table carries an `enabled boolean not null default
false` (shipped as `shared`, renamed by `20260806140000_link_enabled.sql`)
that gates the audience-read policy, keeping "not shared yet"
distinct from "shared with everyone" (the no-row state the sibling share
tables get for free). The CSV route is `/link/[id]/csv` (a path segment,
not `?format=csv`).

A **Link** is a saved GraphQL query a user creates, then shares with the
same audience granularity as any asset share — corporation list, alliance
list, signed link, or public. The defining property: when a viewer opens a
Link, the query runs **under the security context of the creator**, not the
viewer. The viewer receives results, never access. Every Link also renders
to **CSV** in a logical way, positioned to supersede the `api_token` Google
Sheets endpoints (`/api/character/*`, `/api/corp/*`).

## Why creator-context is the right trust model

The creator authors the query against _their own_ data and decides who may
run it — a Link is a window the owner points, exactly like an asset share,
just expressed as a query instead of a subtree. It also cleanly solves what
phase 4 declined to do: external tools and spreadsheet pulls of shared data
go through a Link (creator authorizes), so the api_token path never needs an
audience model of its own.

## Data model

```sql
create table public.link (
  id uuid primary key default gen_random_uuid(),
  -- Creator. user_id-keyed (like shared_asset_token), because a Link spans
  -- all the creator's registrations the way their GraphQL context does.
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  query text not null,
  variables jsonb not null default '{}',
  -- As built: the link row doubles as its share row, so this flag keeps a
  -- freshly created (never-shared) link out of the empty-audience-is-public
  -- reading. The audience policy requires it.
  enabled boolean not null default false,
  corporation_ids bigint[] not null default '{}',
  alliance_ids bigint[] not null default '{}',
  secret text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

Owner policies as usual (all four commands, `user_id = auth.uid()`);
audience-read policy via `share_audience_matches()` so signed-in audience
members can _discover_ links aimed at them. Public = empty lists + null
secret, same as everywhere.

`variables` are **fixed by the creator** at save time. Viewers cannot supply
variables in v1 — a variable substituted into `assets(type: $x)` doesn't
widen access (still the creator's rows), but fixed variables keep the output
exactly what the creator reviewed. Loosen later if wanted, deliberately.

## Execution

`runLink(linkId, viewer)`:

1. Authorize the viewer: session user matching the audience arrays (or
   owner), a valid `?share=<id>.<sig>` signature, or public.
2. Build the **creator's** GraphQL context: service client + the creator's
   `registrationIds`/owner map — exactly what `buildContext` does for
   api_token mode, minus the token lookup (reuse it; factor a
   `contextForUser(userId)` out of `src/app/api/graphql/context.ts`).
3. Execute the stored query in-process against the executable schema
   (`graphql()` from the `graphql` package with `schema` from
   `src/app/api/graphql/schema.ts` — no HTTP hop), with the stored
   variables.
4. Current views only, by construction: the schema _is_ the phase-4 GraphQL
   schema, which never exposes `_over_time` tables. `includeShared`-style
   session-only args are rejected at save time (validate the query against
   the schema, and against a small denylist of session-only fields, when the
   creator saves).

Creator-context execution is the sharpest tool in this project — the
safeguards are that the query text is creator-authored, validated at save,
frozen at run, and scoped by the same resolvers whose leak guard already
assumes a service client.

## Surfaces

- **`/link` — the directory, a new top-level route** (dark-launched behind a
  `link` feature flag at first, launched to everyone once it had soaked; the
  flag and the whole flag mechanism are gone): one line per Link — name, who it is
  issued to (`issuance.ts`, tested), when it last changed — plus the
  create-new editor at the top. **Amended after first use:** as built, this
  page stacked a full editor _and_ a share dialog into every row, so ten Links
  were a scroll rather than a look, and the audience controls for a query sat
  next to a query you weren't reading. Per-link editing and sharing moved to
  the Link's own page; the index is a listing and nothing else.
- **`/link/[id]` for its owner — where a Link is administered.** CSV, Edit and
  Share sit in one corner row of the heading, so issuing a Link happens while
  looking at the results it will hand over. The Edit toggle lives in that row
  but the form opens under the heading (`ownerPanel.tsx` holds the open state;
  `LinkEditor` takes optional controlled `open`/`onOpenChange` for exactly
  this), because a column form crushes inside a flex button row. The Sheets
  `=IMPORTDATA()` formula moved here too — it only exists when the Link is
  issued, so it belongs beside the control that issues it.
- **`/link/[id]`** — the viewer: runs the link (per Execution above),
  renders the result as a table, shows the creator's name (via
  `character_directory`-safe display: link shares are user-scoped, so show
  the link name and nothing about alts).
- **`/link/[id].csv`** (or `?format=csv`) — the CSV rendering: find the
  **primary list** in the result (the single top-level list field; reject
  saving a link with more than one when CSV is enabled — "logical" must stay
  unambiguous), flatten each row's scalar fields to columns via `toCsv()`
  (`src/utils/csv.ts`), nested objects dot-pathed, lists of scalars joined.
  Served like `/api/character/assets` (force-dynamic, `text/csv`), and — for
  link-token links — fetchable by Google Sheets `IMPORTDATA` with the
  signed param, which is what lets Links supersede the bespoke Sheets
  endpoints over time (each existing endpoint becomes "a link you could
  save"; the old routes retire only after parity, in their own cleanup).

## Deliverables

- Migration + `schema.sql` (link table + policies); flag; `/link` editor,
  `/link/[id]` viewer, CSV route; `runLink` + save-time query validation;
  unit tests for the CSV flattening (pure) and the query validator.

## Verification

Creator saves a link over their assets; a corp-mate runs it and sees the
creator's rows (never their own); a non-audience account gets a 403; the
signed CSV URL imports into a spreadsheet; revoking the share/rotating the
secret closes access. Attempting to save a query touching a session-only
arg or a second top-level list fails with a clear message. `pnpm run lint &&
pnpm test && pnpm run build`.

## Follow-up: authoring a link over MCP

**Shipped.** `src/app/api/mcp/linkTools.ts` adds two tools so a link can be
created from a description rather than hand-written GraphQL — "a link on the
container named input, showing every type that goes into fuel blocks, visible
to my corp and to anyone with the URL" is one conversation, not a trip to the
editor.

- **`link_schema`** (read-only) — the SDL, the save-time rules, worked example
  queries, and **the audiences this user can actually aim a link at** (their
  corporations and alliances, with ids). A model can't write a valid query
  against a schema it hasn't seen, and can't name an audience it doesn't know
  the user is in, so this is the required first call.
- **`create_link`** — validates, **runs the query before saving anything**,
  then inserts and applies the audience. Returns the link URL, the CSV URL, the
  signed link when one was asked for, and a **preview of the link's own output**
  (row count, columns, first few rows) so the human can see it answers the
  question. Running first means a query that only fails at run time leaves no
  row behind: nothing is persisted by a preview (it's what the editor's
  Run-as-me does), so the refusal is clean.
- **`list_links`** (read-only) — the caller's own links with their queries,
  audiences and URLs (signed link included). How the model finds the link
  someone is talking about, and how "what's the link for my fuel link again"
  gets answered. Own links only: RLS would also surface ones aimed at the
  caller, which aren't theirs to edit.
- **`update_link`** — change a link's name, query, variables, audience, or any
  combination. **Absent means unchanged**, so a rename doesn't touch the query
  and a re-share doesn't touch either; the audience is only written when the
  call says something about sharing, or a rename would quietly unshare the
  link. Naming any share option replaces the audience wholesale rather than
  adding to it (the tool says so), `unshare` returns a link to private — not
  public — and `rotate_link` invalidates every URL previously issued.

Deleting a link stays in the web editor.

`update_link` runs the query the link _would have_ before writing it, and
refuses the whole edit if it comes back with nothing at all: a link that
already has an audience must never be broken underneath them. Zero rows is
still a legitimate answer — an empty container is worth watching — so only a
run that produced no data is treated as a failure.

Which link an edit means is resolved from a name or an id by
`src/app/link/linkRef.ts`, over the same matcher the audience resolver uses
(`src/app/link/match.ts`: id, then exact name, then unique substring, and
ambiguity is always a refusal). Overwriting the wrong saved query and sharing
with the wrong corporation are the same class of mistake, so they get the same
answer — never a guess.

The model gets from words to arguments with the existing read tools —
`search_assets`/`browse_assets` for the container's item id,
`blueprint_for_product` for a product's input type ids — and puts those into
the query.

### The first write tools on this server

Everything else under `/api/mcp` answers questions. `create_link` and
`update_link` write rows and can publish results to an audience, so they carry
`readOnlyHint: false` (`create_link` with `idempotentHint: false` — calling it
twice makes two links; `update_link` with `idempotentHint: true`, since the
same edit applied twice lands in the same place; `destructiveHint: false` and
`openWorldHint: false` on both) rather than the read-only annotation every
other tool declares. What actually constrains it, as always, is not the hint:

- they write on the **caller's own bearer client**, so RLS pins the row to them
  exactly as the editor's cookie session does — no service role anywhere in the
  path, no creating a link for someone else, and no editing one (`update_link`
  additionally filters to `user_id`, so a link merely shared _with_ the caller
  is invisible to it);
- the audience is resolved against the caller's **own** corporations and
  alliances (`src/app/link/audience.ts`, pure and unit-tested in
  `test/linkAudience.test.ts`), so a link can't be aimed at a group the caller
  isn't in;
- the query goes through the **same `validateLinkQuery`** the editor uses, so a
  link saved from a tool is subject to every rule one saved from the browser
  is;
- the tools were behind the **`link` dark-launch flag** while it existed,
  checked on the caller — the same gate `/link` redirected on. Signing in is
  the whole test now that Links are launched.

`public` is exclusive here rather than absorbing: the dialog silently drops the
corporation list when public is ticked, which is fine for a checkbox someone is
looking at, but a tool told both things has been told two different things and
refuses instead of picking one.

### Shared plumbing

Writing the audience moved out of the `'use server'` module into
`src/app/link/share.ts` (`fetchOwnAudiences`, `applyLinkShare`), which both the
server actions and the tool call — so the editor and the tool can't drift on
what "public" or "not shared yet" mean. `src/utils/siteUrl.ts` is new: the tool
has no HTTP request to read a Host from (the MCP tool context exposes the
verified token and nothing else), so absolute share URLs come from
`NEXT_PUBLIC_SITE_URL` or Vercel's `VERCEL_PROJECT_PRODUCTION_URL`, and fall
back to bare paths rather than a guessed hostname.
