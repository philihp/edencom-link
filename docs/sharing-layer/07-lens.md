# Phase 7: Lenses — shared queries in the creator's context

**Status: ✅ done** — migration `20260806130000_lens.sql`, `/lens` editor
(flag `lens`), `/lens/[id]` viewer, `/lens/[id]/csv`, `runLens` over
`contextForUser()` (factored out of `src/app/api/graphql/context.ts`),
save-time validation in `src/app/lens/validate.ts`, CSV flattening in
`src/app/lens/flatten.ts`; covered by `test/lensValidate.test.ts`,
`test/lensFlatten.test.ts`, `test/sql/lens.sql`. One deviation from the
sketch below, found while building: because the lens row IS the share row,
the Revision 3 "empty audience = public" reading would have made a freshly
created lens public — the table carries an `enabled boolean not null default
false` (shipped as `shared`, renamed by `20260806140000_lens_enabled.sql`)
that gates the audience-read policy, keeping "not shared yet"
distinct from "shared with everyone" (the no-row state the sibling share
tables get for free). The CSV route is `/lens/[id]/csv` (a path segment,
not `?format=csv`).

A **Lens** is a saved GraphQL query a user creates, then shares with the
same audience granularity as any asset share — corporation list, alliance
list, signed link, or public. The defining property: when a viewer opens a
Lens, the query runs **under the security context of the creator**, not the
viewer. The viewer receives results, never access. Every Lens also renders
to **CSV** in a logical way, positioned to supersede the `api_token` Google
Sheets endpoints (`/api/character/*`, `/api/corp/*`).

## Why creator-context is the right trust model

The creator authors the query against _their own_ data and decides who may
run it — a Lens is a window the owner points, exactly like an asset share,
just expressed as a query instead of a subtree. It also cleanly solves what
phase 4 declined to do: external tools and spreadsheet pulls of shared data
go through a Lens (creator authorizes), so the api_token path never needs an
audience model of its own.

## Data model

```sql
create table public.lens (
  id uuid primary key default gen_random_uuid(),
  -- Creator. user_id-keyed (like shared_asset_token), because a Lens spans
  -- all the creator's registrations the way their GraphQL context does.
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  query text not null,
  variables jsonb not null default '{}',
  -- As built: the lens row doubles as its share row, so this flag keeps a
  -- freshly created (never-shared) lens out of the empty-audience-is-public
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
members can _discover_ lenses aimed at them. Public = empty lists + null
secret, same as everywhere.

`variables` are **fixed by the creator** at save time. Viewers cannot supply
variables in v1 — a variable substituted into `assets(typeName: $x)` doesn't
widen access (still the creator's rows), but fixed variables keep the output
exactly what the creator reviewed. Loosen later if wanted, deliberately.

## Execution

`runLens(lensId, viewer)`:

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

- **`/lens` — the editor, a new top-level route, dark-launched behind a
  feature flag** (`LENS_FLAG = 'lens'` in `src/flags.ts`, the same
  gate-and-redirect shape as `/graphql`): list your lenses, create/edit
  (query textarea + variables + a Run-as-me preview reusing the `/graphql`
  editor component), and the share dialog for the audience.
- **`/lens/[id]`** — the viewer: runs the lens (per Execution above),
  renders the result as a table, shows the creator's name (via
  `character_directory`-safe display: lens shares are user-scoped, so show
  the lens name and nothing about alts).
- **`/lens/[id].csv`** (or `?format=csv`) — the CSV rendering: find the
  **primary list** in the result (the single top-level list field; reject
  saving a lens with more than one when CSV is enabled — "logical" must stay
  unambiguous), flatten each row's scalar fields to columns via `toCsv()`
  (`src/utils/csv.ts`), nested objects dot-pathed, lists of scalars joined.
  Served like `/api/character/assets` (force-dynamic, `text/csv`), and — for
  link-token lenses — fetchable by Google Sheets `IMPORTDATA` with the
  signed param, which is what lets Lenses supersede the bespoke Sheets
  endpoints over time (each existing endpoint becomes "a lens you could
  save"; the old routes retire only after parity, in their own cleanup).

## Deliverables

- Migration + `schema.sql` (lens table + policies); flag; `/lens` editor,
  `/lens/[id]` viewer, CSV route; `runLens` + save-time query validation;
  unit tests for the CSV flattening (pure) and the query validator.

## Verification

Creator saves a lens over their assets; a corp-mate runs it and sees the
creator's rows (never their own); a non-audience account gets a 403; the
signed CSV URL imports into a spreadsheet; revoking the share/rotating the
secret closes access. Attempting to save a query touching a session-only
arg or a second top-level list fails with a clear message. `pnpm run lint &&
pnpm test && pnpm run build`.

## Follow-up: authoring a lens over MCP

**Shipped.** `src/app/api/mcp/lensTools.ts` adds two tools so a lens can be
created from a description rather than hand-written GraphQL — "a lens on the
container named input, showing every type that goes into fuel blocks, visible
to my corp and to anyone with the URL" is one conversation, not a trip to the
editor.

- **`lens_schema`** (read-only) — the SDL, the save-time rules, worked example
  queries, and **the audiences this user can actually aim a lens at** (their
  corporations and alliances, with ids). A model can't write a valid query
  against a schema it hasn't seen, and can't name an audience it doesn't know
  the user is in, so this is the required first call.
- **`create_lens`** — validates and inserts, applies the audience, and returns
  the lens URL, the CSV URL, the signed link when one was asked for, and a
  **preview of the lens's own output** (row count, columns, first few rows) so
  the human can see it answers the question before it's shared. Editing and
  deleting stay in the web editor; this is a create-only surface.

The model gets from words to arguments with the existing read tools —
`search_assets`/`browse_assets` for the container's item id,
`blueprint_for_product` for a product's input type ids — and puts those into
the query.

### The first write tools on this server

Everything else under `/api/mcp` answers questions. `create_lens` inserts a row
and can publish its results to an audience, so it carries
`readOnlyHint: false` (with `destructiveHint: false`, `idempotentHint: false`,
`openWorldHint: false`) rather than the read-only annotation every other tool
declares. What actually constrains it, as always, is not the hint:

- it writes on the **caller's own bearer client**, so RLS pins the row to them
  exactly as the editor's cookie session does — no service role anywhere in the
  path, and no creating a lens for someone else;
- the audience is resolved against the caller's **own** corporations and
  alliances (`src/app/lens/audience.ts`, pure and unit-tested in
  `test/lensAudience.test.ts`), so a lens can't be aimed at a group the caller
  isn't in;
- the query goes through the **same `validateLensQuery`** the editor uses, so a
  lens saved from a tool is subject to every rule one saved from the browser
  is;
- the whole surface is behind the **`lens` dark-launch flag**, checked on the
  caller — the same gate `/lens` redirects on, so un-flagging an account turns
  the tools off with it.

`public` is exclusive here rather than absorbing: the dialog silently drops the
corporation list when public is ticked, which is fine for a checkbox someone is
looking at, but a tool told both things has been told two different things and
refuses instead of picking one.

### Shared plumbing

Writing the audience moved out of the `'use server'` module into
`src/app/lens/share.ts` (`fetchOwnAudiences`, `applyLensShare`), which both the
server actions and the tool call — so the editor and the tool can't drift on
what "public" or "not shared yet" mean. `src/utils/siteUrl.ts` is new: the tool
has no HTTP request to read a Host from (the MCP tool context exposes the
verified token and nothing else), so absolute share URLs come from
`NEXT_PUBLIC_SITE_URL` or Vercel's `VERCEL_PROJECT_PRODUCTION_URL`, and fall
back to bare paths rather than a guessed hostname.
