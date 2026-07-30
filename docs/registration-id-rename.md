# Future project: stop calling registration uuids `character_id`

Across most of the schema, a column named `character_id` does **not** hold a
character id. It holds `registration(id)` — the uuid surrogate key of the row
binding an EVE character to an account. The actual EVE numeric character id
lives in `registration.character_id`, and in exactly two other places.

The convention we want (recorded in `CLAUDE.md`) is:

- **`character_id`** = the bigint id CCP assigns. What ESI takes, what
  `images.evetech.net` serves portraits for.
- **`registration_id`** = the uuid primary key of `registration`.

This doc inventories every place that violates it, and sketches how to fix it
without breaking production. Nothing here is urgent — the naming is wrong, not
broken. It's written down so the mistake stays legible instead of being
re-derived every time someone reads the schema and gets confused.

## Why it's worth fixing eventually

It isn't cosmetic in one specific spot. `src/jobs/lib.js` hands every extract
job a handler argument object containing **both senses at once**:

```js
async ({ access_token, characterID, character_id, name }) => { … }
//                     ^ EVE id      ^ registration uuid
```

Two identifiers one capital letter apart, meaning different things, destructured
side by side in a dozen job modules. That's the shape of a real bug waiting to
happen, and it's the reason this is worth doing rather than just documenting.

The rest is confusion tax: reading `character_id` in a query and having to check
the column type to know what it is, and every new table facing a choice between
matching its neighbours and being correct.

## What's already correct

Three columns name it right, all `bigint`, all genuinely the EVE id:

| Table                   | Column                                                  |
| ----------------------- | ------------------------------------------------------- |
| `registration`          | `character_id`                                          |
| `character_directory`   | `character_id` (PK), with the uuid as `registration_id` |
| `character_affiliation` | `character_id` (PK)                                     |

`character_directory` is the model to copy: it carries both ids and names each
one accurately.

The two fitting tables were converted in #749 and now use `registration_id`,
which is what let `/fitting/[characterId]/[fittingId]` address fits by the EVE
id without the two senses colliding inside one page. They're the worked example
for everything below.

## Inventory

### Table columns — 19 (1 done, 18 remaining)

All declared `character_id uuid not null references public.registration(id)`
(a couple are nullable or `primary key`, otherwise identical):

| Table                               | Notes                                                                |
| ----------------------------------- | -------------------------------------------------------------------- |
| ~~`token`~~                         | **Done** — renamed in the step-1 PR                                  |
| `character_asset_over_time`         |                                                                      |
| `character_blueprint_over_time`     |                                                                      |
| `character_wallet`                  |                                                                      |
| `character_wallet_transaction`      |                                                                      |
| `character_order_over_time`         |                                                                      |
| `character_industry_job_over_time`  |                                                                      |
| `character_location`                | PK                                                                   |
| `character_clone_over_time`         |                                                                      |
| `character_clone_state`             | PK                                                                   |
| `character_implant`                 | PK                                                                   |
| `character_skill_over_time`         |                                                                      |
| `character_ship_over_time`          |                                                                      |
| `character_mercenary_den_over_time` |                                                                      |
| `character_mercenary_den_status`    |                                                                      |
| `character_mercenary_den_share`     | Already commented as a known wart in `schema.sql`                    |
| `heartbeat`                         | Not a `character_*` extract table                                    |
| `refresh_task`                      | Not a `character_*` extract table                                    |
| `corp_wallet_transaction`           | A `corp_*` table; holds the registration whose token scanned the row |

### Views — 8

These `select *` from the tables above, so they republish whatever the base
column is called and must be dropped/recreated as part of any rename:

`character_asset`, `character_blueprint`, `character_order`,
`character_industry_job`, `character_clone`, `character_skill`,
`character_ship`, `character_mercenary_den`

### Function signatures — 11

Parameters (`character_ids uuid[]`): `character_asset_snapshot_at`,
`character_blueprints`, `character_orders`, `character_industry_jobs`,
`corp_assets`, `corp_blueprints`, `blueprint_search`, `corp_industry_jobs`

Return columns (`character_id uuid`): `character_asset_location_summary`,
`character_asset_search`, `latest_heartbeats`

### JavaScript / TypeScript — 4 modules

- **`src/jobs/lib.js`** — ~~the `characterID` / `character_id` pair~~ (done);
  the `characterIds` option (registration uuids) on `forEachCharacter` /
  `forEachCharacterAnyScope` / `forEachCorporation` remains, and shares its
  name with three unrelated contracts — see step 2.
- **`src/supabase.js`** — `recordHeartbeat(opts.characterId)`,
  `selectCharacterIdsWithScopes()` (returns uuids), `selectToken(character_id)`,
  `upsertToken`'s `onConflict: ['character_id']`.
- **`src/observability.js`** — `recordEsiConditional({ characterId })` emits a
  `character_id` metric field holding a uuid. Renaming changes the shape of
  metric lines already queried in Vercel Observability.
- **`src/app/api/mcp/lib.ts`** — `OwnerContext.characterIds` is registration
  uuids, and it's what `resolveOwnerFilter` matches on across every MCP tool.

## Migration mechanics: what a rename does and doesn't carry

Learned the hard way in #749. `alter table … rename column` **does**
automatically update indexes, constraints, and RLS policy expressions —
Postgres stores those as parsed trees keyed on attnum, so they follow the
column. It does **not** update:

- **Views.** `create view v as select * from t` expands the `*` into an explicit
  target list at creation time, and the view's own output column names are fixed
  then. After a base-column rename the view keeps publishing the **old** name.
  `create or replace view` can't rename columns either — it has to be dropped
  and recreated.
- **Classic string-body SQL functions** (`as $$ … $$`). The body is stored as
  text and re-parsed at execution, so a rename leaves the function referencing a
  column that no longer exists — and nothing fails at migration time. It breaks
  at the next query. Drop and recreate the function, and drop any policy that
  calls it first (both so the drop is permitted and so the policy's call
  re-binds to the new parameter names).

Also worth knowing:

- **RPC parameters are passed by name** from supabase-js
  (`supabase.rpc('character_orders', { character_ids: [...] })`). Renaming a
  function parameter is a breaking change to every call site, and there are
  ~11 of them across `src/app/api/**` and the MCP tools. Schema and callers must
  ship together.
- **Deploy ordering.** Migrations apply on push to `main` via the `Migrate`
  workflow while Vercel builds the new deployment; the two aren't atomic. A
  straight rename therefore has a window where the running code and the schema
  disagree. For this app's traffic that's likely acceptable, but the
  belt-and-braces alternative is the standard three-step: add the new column,
  backfill and dual-write, migrate readers, then drop the old one in a later
  release.

## Suggested staging

Smallest blast radius first, and ordered so each step makes the next easier.

1. ~~**`token`.**~~ **Done.** One column, one table, no view over it, and its
   RLS policy gates on `user_id` — so the rename carried its FK, unique
   constraint and indexes by itself, with no view or function to recreate. It
   also touched `src/app/character/callback/route.ts`, `src/refresh.js` and
   `src/jobs/universeStructures.js`, which the original sketch here missed.
2. ~~**`src/jobs/lib.js`'s handler contract.**~~ **Field done.** The handler
   argument is now `registration_id`, swept through all 14 job modules and both
   `sync*` helper signatures — which retires the `characterID` /
   `character_id` collision. Note the intermediate state it leaves: where a job
   writes that value into a column still called `character_id`, the payload is
   now an explicit `character_id: registration_id` rather than shorthand. That
   reads awkwardly on purpose, and each one disappears as step 4 renames its
   table.

   The **`characterIds` option** was deliberately left alone. It looked like
   part of the same rename, but `characterIds` turns out to name three other
   unrelated contracts too — `OwnerContext.characterIds` in the MCP layer,
   `resolvePlayer`'s return in `src/utils/apiToken.ts`, and the `character_ids`
   RPC parameter — spanning ~55 files. Renaming only lib.js's would leave the
   name meaning two things at once. It belongs with those, as its own step.

3. **Infrastructure tables** — `heartbeat`, `refresh_task`. Small, and
   `heartbeat` also drags `latest_heartbeats()`'s return column, so it's a good
   dry run of the function-recreation dance.
4. **Extract tables, one family at a time** — assets, then blueprints, then
   orders/jobs, and so on. Each family is a table + its view + any function that
   returns or filters on the column + the job that writes it. Keeping families
   separate keeps each PR reviewable and each revert cheap.
5. **Function parameters last**, in lockstep with their call sites, since
   that's the one part with no backward compatibility at all.
6. **`corp_wallet_transaction`** whenever convenient — it's isolated, but it
   deserves a moment's thought about whether `registration_id` is even the right
   name there, or whether the column wants to be `scanned_by_registration_id`.

`src/observability.js` can be left alone or done last: renaming the metric
field breaks continuity of any saved Observability query, which is a cost with
no correctness benefit.

## Explicitly not in scope

Renaming `registration.id` itself, or adding a `registration_id` alias column
anywhere. The uuid is the right foreign key for these tables — it cascades on
delete and binds data to an account's registration rather than to a raw EVE id
another account could later register. Only the **name** is wrong.
