# Phase 4: shared rows in GraphQL

**Status: ✅ done** — `assets(includeShared:)` + `sharedWithMe` in
`schema.graphql.ts`/`resolvers.ts`, both session-only (`requireSession`);
foreign owner names resolve through `character_directory` via the shared
`ownerNamesFor` helper. No DB changes, per the plan.

Let a grantee query what's been shared with them through `/api/graphql`, so
shared stockpiles are scriptable, not just browsable. **Current views only —
the `_over_time` SCD tables are never exposed over GraphQL**, shared or
owned; that invariant predates this phase and survives every future one.

## What phase 2 already gives us, and what blocks it

In **session mode** the GraphQL context queries as the caller, so once the
widening policy exists, `character_asset` selects would return shared rows —
except the resolvers deliberately hard-scope every query with
`.in('registration_id', ctx.registrationIds)` (the leak guard that keeps
api_token/service mode safe). That guard is correct and stays; shared rows
therefore need an explicit, opt-in path rather than an accidental one.

## Schema changes

- `assets(..., includeShared: Boolean = false)` — when true **in session
  mode**, the resolver widens its filter to `registration_id in (own ∪
grantor registrations)` and lets RLS decide which grantor rows actually
  come back (the DB is the authority; the widened `.in()` is just no longer
  the barrier). Grantor registration ids come from the share rows the caller
  can read (`character_asset_share` audience policy) — one small query in the
  resolver.
- `sharedWithMe: [ShareGrant!]!` — discovery: the shares whose audience the
  caller matches, each `{ shareId, ownerName, itemId, itemTypeName,
sharedAt }`. Owner name resolves through the world-readable
  `character_directory` (never `registration`), exactly like `list_fittings`
  handles foreign owners in the MCP layer.
- `Asset.ownerName` for a shared row resolves via `character_directory` too;
  `ownerId` stays the grantor registration uuid.

## api_token mode stays own-data-only

The Bearer path runs on the **service client**, where RLS can't arbitrate a
widened filter — honoring `includeShared` there would mean re-implementing
the whole audience+recursion model in JS against the service role. Don't.
`includeShared` in token mode returns a clear GraphQL error ("shared data
requires a session; use a Lens"), and phase 7's Lens is the designed answer
for external tools consuming shared data (the creator's context does the
authorizing instead).

## Deliverables

- `schema.graphql.ts` + `resolvers.ts` changes; `test/graphqlSchema.test.ts`
  updated for the new field/args (the drift guard exists for exactly this).
- No DB changes.

## Verification

Two accounts: B's `assets(includeShared: true)` returns A's shared container
contents and nothing else of A's; `sharedWithMe` lists the grant; the same
queries over B's api_token error as specified; `pnpm run lint && pnpm test &&
pnpm run build`.
