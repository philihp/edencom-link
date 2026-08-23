# The bpo_share timestamp collision

`bpo_share` — the share row behind `/bpos/[name]` — merged in #946 but never
reached production. This is what happened, how to repair it, and what the
episode says about a claim in CLAUDE.md that turned out to be too optimistic.

## What happened

#945 and #946 merged sixteen seconds apart, each carrying a migration stamped
`20260822120000`:

| file | PR | merged |
| --- | --- | --- |
| `20260822120000_structure_tax_revenue_split_signs.sql` | #945 | 23:43:20 |
| `20260822120000_bpo_share.sql` | #946 | 23:43:39 |

Neither PR's ordering-guard run could see the collision: `check-migrations.mjs`
compares a branch against `origin/main` **as it stands**, and when each ran, the
other's migration had not merged. This is precisely the "two open PRs with the
same new timestamp" case the guard is documented as unable to catch.

`Migrate` serializes on a concurrency group, so #945's run went first and
applied its migration cleanly, recording `(20260822120000,
structure_tax_revenue_split_signs)`.

#946's run then compared **two** local files at version `20260822120000` against
the **one** remote history row. The Supabase CLI matches by version, consuming
local files in sorted order — so `bpo_share`, alphabetically first, was matched
to that row and treated as already applied. It never ran. That left
`structure_tax_revenue_split_signs` looking pending, and re-applying it hit the
composite primary key:

```
ERROR: duplicate key value violates unique constraint "schema_migrations_pkey" (SQLSTATE 23505)
Key (version, name)=(20260822120000, structure_tax_revenue_split_signs) already exists.
```

Two things are worth separating here. The `(version, name)` key **did its job**:
it refused a double apply, and the database is not corrupt. But it did not make
`db push` work — the CLI has no way to reconcile a remote history keyed on
`(version, name)` with its own version-keyed matching, so the push aborts and
every migration after the collision is unreachable. A new migration alone
therefore does **not** unwedge the pipeline; the history has to be repaired
first.

## Repair

One statement, run once against production (Supabase SQL editor, or any
service-role psql session). It records the stranded file as applied **without
running it** — its content is superseded by
`20260823005000_create_bpo_share.sql`, which does the actual DDL:

```sql
insert into supabase_migrations.schema_migrations (version, name, statements)
values ('20260822120000', 'bpo_share', array[]::text[])
on conflict (version, name) do nothing;
```

After that, local and remote agree on both entries at `20260822120000`, and the
next `supabase db push --include-all` — the `Migrate` workflow, or a manual run
— applies `20260823005000_create_bpo_share.sql` and creates the table.

To confirm:

```sql
select version, name from supabase_migrations.schema_migrations
 where version >= '20260822120000' order by version, name;
select to_regclass('public.bpo_share');   -- expect: bpo_share
```

`20260823005000_create_bpo_share.sql` is idempotent throughout (`create table if
not exists`, `drop policy if exists` before each `create policy`), so it is a
no-op anywhere the original did land — the ephemeral preview branch CI
provisions for `test:branch`, for instance.

## What the app does meanwhile

Nothing breaks loudly. `bposAccess()` reads `bpo_share` through the service
role; against a missing table PostgREST errors, the read yields no row, and the
function returns `null` — which reads as "not shared". So `/bpos/[name]` 404s
for everyone except the owner, and the owner's share dialog opens but cannot
save. That is a fail-closed outcome, not a leak.

## The claim this corrects

CLAUDE.md said the composite key "covers what [the guard] can't catch (two open
PRs with the same new timestamp merging)". It doesn't. It covers the
*database* — no bad row, no double apply — but it leaves `db push` unable to
proceed, which is worse operationally than a clean failure, because the
migration that goes missing is silently skipped rather than reported.

The only real mitigation stays the one already in the Workflow section: give
every migration a distinct timestamp from the current clock, so two PRs opened
the same day don't collide. `pnpm run db:new` does this; a hand-copied timestamp
is what to avoid.
