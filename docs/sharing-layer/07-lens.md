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
