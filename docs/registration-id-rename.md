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

### Table columns — 19 (all done)

All declared `character_id uuid not null references public.registration(id)`
(a couple are nullable or `primary key`, otherwise identical):

| Table                                   | Notes                                                                |
| --------------------------------------- | -------------------------------------------------------------------- |
| ~~`token`~~                             | **Done** — renamed in the step-1 PR                                  |
| ~~`character_asset_over_time`~~         |                                                                      |
| ~~`character_blueprint_over_time`~~     |                                                                      |
| ~~`character_wallet`~~                  |                                                                      |
| ~~`character_wallet_transaction`~~      |                                                                      |
| ~~`character_order_over_time`~~         |                                                                      |
| ~~`character_industry_job_over_time`~~  |                                                                      |
| ~~`character_location`~~                | PK                                                                   |
| ~~`character_clone_over_time`~~         |                                                                      |
| ~~`character_clone_state`~~             | PK                                                                   |
| ~~`character_implant`~~                 | PK                                                                   |
| ~~`character_skill_over_time`~~         |                                                                      |
| ~~`character_ship_over_time`~~          |                                                                      |
| ~~`character_mercenary_den_over_time`~~ |                                                                      |
| ~~`character_mercenary_den_status`~~    |                                                                      |
| ~~`character_mercenary_den_share`~~     | Was the last one — step 6                                            |
| ~~`heartbeat`~~                         | Not a `character_*` extract table                                    |
| ~~`refresh_task`~~                      | Not a `character_*` extract table                                    |
| ~~`corp_wallet_transaction`~~           | A `corp_*` table; holds the registration whose token scanned the row |

### Views — 8

These `select *` from the tables above, so they republish whatever the base
column is called and must be dropped/recreated as part of any rename:

~~`character_asset`~~, ~~`character_blueprint`~~, ~~`character_order`~~,
~~`character_industry_job`~~, ~~`character_clone`~~, ~~`character_skill`~~,
~~`character_ship`~~, ~~`character_mercenary_den`~~ (struck ones done in the
step-5 tranches so far)

### Function signatures — 11

Parameters (`character_ids uuid[]` → `registration_ids`): ~~`character_asset_snapshot_at`,
`character_blueprints`, `character_orders`, `character_industry_jobs`,
`corp_assets`, `corp_blueprints`, `blueprint_search`, `corp_industry_jobs`~~
— **all done** in step 7.

Return columns (`character_id uuid`): ~~`character_asset_location_summary`~~,
~~`character_asset_search`~~, ~~`latest_heartbeats`~~ — **all done**. Each
needed a DROP rather than CREATE OR REPLACE, since renaming a `RETURNS TABLE`
column is a return-type change.

### JavaScript / TypeScript — 4 modules

- **`src/jobs/lib.js`** — ~~the `characterID` / `character_id` pair~~ (done);
  the `characterIds` option (registration uuids) on `forEachCharacter` /
  `forEachCharacterAnyScope` / `forEachCorporation` remains, and shares its
  name with three unrelated contracts — see step 2.
- **`src/supabase.js`** — ~~`recordHeartbeat(opts.characterId)`~~ (done),
  ~~`selectToken`~~ and ~~`upsertToken`~~ (done in step 1);
  `selectCharacterIdsWithScopes()` still returns uuids under a
  character-flavoured name — see step 8.
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

3. ~~**Infrastructure tables.**~~ **`refresh_task` done** (in the step-3 batch
   below); `heartbeat` deferred — see step 4.

**Step 3 (done): every table with no dependent object.** Seven tables —
`character_wallet`, `character_wallet_transaction`, `character_implant`,
`character_location`, `character_clone_state`, `corp_wallet_transaction`,
`refresh_task` — renamed in one migration. Verified beforehand that no
`create view` or `create function` in `schema.sql` references any of them, so
the rename carried its policies and indexes by itself and nothing had to be
recreated. Batching them was deliberate: each rename PR costs one window where
the deployed code and the schema disagree, and that cost is per-PR, not per
table.

## What's left, hardest-last

Everything remaining needs _something else recreated in a specific order_,
which is exactly what makes it not part of the easy batch.

4. ~~**`heartbeat`.**~~ **Done.** Both dependent objects behaved as the
   mechanics section predicts, and the interesting one is now settled: the
   `owner_key` **generated column** expression _did_ follow the rename, like
   policy expressions do. Rather than trust that, the migration asserts it in a
   `DO` block against `pg_get_expr(pg_attrdef…)` and raises if the expression
   still names the old column — because the failure mode was silent (start/end
   heartbeat rows would stop pairing on `heartbeat_run_idx`, doubling instead
   of erroring). Worth copying that assertion shape wherever a rename's
   correctness can't be seen in the diff.

   `latest_heartbeats()` had to be dropped rather than replaced: `CREATE OR
REPLACE FUNCTION` can't rename a `RETURNS TABLE` column, since that's a
   return-type change. No policy calls it (it's reached over RPC), so nothing
   needed dropping ahead of it.

5. **The SCD families**, each = table + its `is_current` view (dropped and
   recreated, since `select *` freezes the view's output column names) + the
   job that writes it. Smallest first:
   - ~~`character_ship_over_time` / `character_ship`~~ **Done**
   - ~~`character_skill_over_time` / `character_skill`~~ **Done**
   - ~~`character_clone_over_time` / `character_clone`~~ **Done**

   Those three went in one migration, batched on the same reasoning as step 3:
   their **only** dependent object is their own view, nothing in `schema.sql`
   reads them otherwise, and the deploy window is per-PR rather than per table.
   Measured rather than assumed — the check that decided the batch was grepping
   `schema.sql` for every `from`/`join` against each table _and_ each view,
   which is also what disqualified the rest of this list.

   The migration asserts the recreated views both ways (no `character_id`
   published, `registration_id` present), because a `select *` view that was
   dropped and recreated against the wrong table is not visible in a diff —
   the three differ only by name. Same instinct as step 4's generated-column
   assertion.

   Readers were updated by hand, not by script: `/character` and the MCP
   `list_job_slots` both read a renamed family's rows a few lines from an
   unrenamed one's (skills beside industry jobs), so a blanket replacement
   would have silently renamed the wrong `character_id`. That's the mistake
   from #752, and hand-editing is the mitigation.

   Still to do here:
   - ~~`character_mercenary_den_over_time` + `character_mercenary_den_status` /
     `character_mercenary_den`~~ **Done** — the two tables moved together
     because the view joins both and the status table's RLS policy correlates
     them on this very column. Two policies followed the rename untouched (the
     status correlation, and the one passing the den's column into
     `mercenary_den_shared_with_caller`), which is the parse-tree behaviour the
     mechanics section describes. The view's `d.*` did not, so it was dropped
     and recreated, and the migration asserts the result — including that the
     lateral join still publishes all six status columns, since a lateral
     correlated on the wrong column doesn't error, it just silently reports
     every den as never-observed on a page whose whole job is showing which
     dens are under attack.

     `character_mercenary_den_share` was deliberately left alone; it's step 6,
     and `mercenary_den_shared_with_caller()` reads only that table, so its
     body stayed valid across this migration.

   - ~~`character_order_over_time` / `character_order`
     (+ `character_orders()`)~~ **Done** — the first family where a SQL
     function moved with the table. `CREATE OR REPLACE` was enough for it,
     unlike `latest_heartbeats()` in step 4: what forced a drop there was
     renaming a `RETURNS TABLE` column (a return-type change), whereas this
     one returns plain `json` and keeps its exact signature, so only the body
     moved.

     Its **parameter stays `character_ids`** — that's step 7, and it has to
     ship in lockstep with every RPC call site. So the recreated body reads
     `where o.registration_id = any(character_ids)`, both senses side by side,
     the same deliberate awkwardness step 2 left in the job payloads.

     Worth recording a near-miss: a line-wise `character_id → registration_id`
     replacement over `schema.sql` also rewrote `any(character_ids)` into
     `any(registration_ids)`, silently renaming the parameter and breaking
     every caller. Per-line asserts don't catch it, because the line _did_
     change. Only reading the rewritten lines back did. Check the function
     bodies by eye whenever a table rename touches one.

   - ~~`character_industry_job_over_time` / `character_industry_job`
     (+ `character_industry_jobs()`)~~ **Done** — same shape as the order
     rename, with one wrinkle: this table has a _second_ column with
     `character_id` in its name, `completed_character_id`, and that one is a
     genuine EVE numeric id (whoever delivered the job, who needn't be a linked
     character). It is one of the few columns in the schema already correct
     under this convention, so renaming it would move things backwards. Every
     replacement was anchored to avoid it, and the migration asserts it
     survived — a rename that swept it up wouldn't fail anywhere, the column
     would just vanish from the view and the Sheets payload would quietly go
     one column short.

     `corp_industry_job_over_time` is keyed on `corporation_id` and
     `corp_industry_jobs()` reaches `registration` by `id = any(character_ids)`
     without naming this table's column, so the corp side was not entangled.

   - ~~`character_blueprint_over_time` / `character_blueprint`
     (+ `character_blueprints()`)~~ **Done** — two firsts here. Its functions
     read the **view**, not the `_over_time` table, so the view has to be
     recreated _before_ them or their bodies bind against a view still
     publishing the old name; the ordering in that migration is load-bearing.
     And there are two of them: `character_blueprints()` plus the ~200-line
     `blueprint_search()`.

     Both were reproduced verbatim by extracting them from the edited
     `schema.sql` rather than retyped, so a migrated database and a
     from-scratch reset cannot disagree about a function that size.

     `blueprint_search()` went into its **own** migration file, because
     `test/sql/blueprint_search.sql` builds stand-in tables and then
     `\i`-includes the migration defining that function — so it must live in a
     file containing nothing but the function and its grant. That test's stub
     table and its include line both needed updating, and it was run for real
     against a throwaway Postgres to confirm: green after, and
     `column b.character_id does not exist` when pointed back at the old
     definition. Worth remembering that `pnpm test` alone would not have caught
     this — `pnpm run test:sql` is a separate command needing a database.

   - ~~`character_asset_over_time` / `character_asset`~~ **Done** — the widest,
     and deliberately last. The four functions split into two kinds:
     `character_asset_location_summary()` and `character_asset_search()`
     publish the column in their `RETURNS TABLE`, so both had to be **dropped**
     and recreated (and re-granted — DROP discards the ACL, and both carry an
     explicit grant); `character_asset_snapshot_at()` returns json, so
     CREATE OR REPLACE sufficed.

     Those two are the only renames in this entire cleanup that change a
     contract JavaScript reads **by name**, so their callers moved in the same
     commit — `/asset`, `/asset/search`, and the MCP `browse_assets` /
     `search_assets` tools.

     `character_asset_location_contents()` and `asset_ancestors()` read the
     view but never name the owner column, so both were left completely alone —
     verified by grep rather than assumed, `asset_ancestors()` being the one
     recursive CTE in the schema and unpleasant to debug from a runtime error.

     Three comments left stale by _earlier_ steps of this migration were fixed
     here too (`src/jobs/lib.js`, the queue route, `src/workflows/lib.ts`, which
     still described `token.character_id` after step 1 renamed it), plus the
     `character_asset_share` sketch in docs/sharing-layer/design.md.

**Step 5 is complete.** All eight SCD families now use `registration_id`.

6. ~~**`character_mercenary_den_share`**~~ **Done** — the last column rename in
   this cleanup. It turned out _not_ to need the #749 treatment: dropping the
   policies and the function first is only necessary when the function's
   **signature** changes, and here `mercenary_den_shared_with_caller(reg_id
uuid) returns boolean` is untouched — only its body moves. So
   `CREATE OR REPLACE` sufficed and the two policies calling it kept their
   dependency intact.

   The helper is the whole risk: it reads only this table, its body is
   re-parsed at execution, and its next call is an RLS policy evaluation on
   `character_mercenary_den_over_time` and `mercenary_den_enemy_intel`. A
   visibility helper that throws doesn't degrade gracefully — every shared den
   and every piece of enemy intel would error out of /mercenary-dens.

   This migration was **run against a throwaway Postgres** rather than reasoned
   about, which confirmed two things worth recording: the primary key and all
   three owner policies (including the INSERT policy's `WITH CHECK`) are
   rewritten by the rename automatically, and the guard genuinely fires —
   a variant that renamed the column but skipped the helper aborted with
   _"still references sh.character_id"_. Cheap to do, and the only way to know
   an assertion works is to watch it fail.

7. ~~**Function parameters**~~ **Done.** The thing the sketch above missed:
   **a parameter rename requires DROP, not CREATE OR REPLACE.** Postgres
   refuses outright —

   ```
   ERROR:  cannot change name of input parameter "character_ids"
   HINT:   Use DROP FUNCTION f(uuid[]) first.
   ```

   — which makes step 7 structurally unlike steps 5's tranches, where only
   bodies moved. Confirmed against a real Postgres before writing anything.
   Dropping was safe because none of the eight is called from a policy, and the
   DROPs name the _old_ signature, which still resolves: a drop matches on
   parameter **types**, and those don't change. Grants had to be re-applied.

   The no-backward-compatibility warning held exactly as written, and it makes
   this the one migration in the whole cleanup whose deploy window is a real
   (if brief) outage rather than harmless skew — a stale deployment sending
   `character_ids` gets "function does not exist" rather than a wrong answer.

   Two tests turned out to pin the old names, and neither is run by
   `pnpm test` alone finding them: `test/sql/blueprint_search.sql` (which
   `\i`-includes the migration defining the function) and a JS↔SQL parity test
   in `test/blueprintQuery.test.ts` that read a **hardcoded** migration path.
   The parity test was rewritten to locate the newest migration defining
   `blueprint_search` itself, so the next redefinition doesn't silently assert
   against a superseded signature — and it was verified to still fail on a
   deliberately wrong parameter name.

8. **The JS-only contracts** — the `characterIds` option on `forEachCharacter`,
   `OwnerContext.characterIds`, `resolvePlayer`'s return, and
   `recordEsiConditional`'s metric field. No migration, no deploy window, so
   these can be interleaved anywhere. Do the three `characterIds` contracts
   together, since they share the name. `src/observability.js` is the one thing
   worth _not_ doing: renaming the metric field breaks continuity of any saved
   Vercel Observability query for no correctness gain.

`src/observability.js` can be left alone or done last: renaming the metric
field breaks continuity of any saved Observability query, which is a cost with
no correctness benefit.

## Explicitly not in scope

Renaming `registration.id` itself, or adding a `registration_id` alias column
anywhere. The uuid is the right foreign key for these tables — it cascades on
delete and binds data to an account's registration rather than to a raw EVE id
another account could later register. Only the **name** is wrong.
