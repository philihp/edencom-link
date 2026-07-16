# PR 0 (tiny): drop the legacy `evesde` schema

**Check first whether this already happened** — look for an existing migration
matching `supabase/migrations/*drop_evesde*` or ask the repo owner. If it's
done, skip this document entirely.

## Context

A schema named `evesde` exists in the hosted Supabase database. It was loaded
out-of-band years ago (a Fuzzwork-style SDE dump), has been stale ever since,
and **nothing in this repo queries it** — CLAUDE.md has long marked it
off-limits. The fresh SDE data now lives in the `public` schema's `sde_*`
tables (nightly `sde-mirror` workflow), so the dead schema should be removed
to avoid confusion. The repo owner explicitly requested this drop.

## Changes

1. New migration `supabase/migrations/<timestamp>_drop_evesde_schema.sql`
   (pick a 14-digit UTC timestamp later than every existing migration):

```sql
-- Remove the legacy `evesde` schema. It was loaded out-of-band years ago (a
-- Fuzzwork-style SDE dump), has been stale ever since, and nothing in this
-- codebase queries it — CLAUDE.md has long marked it off-limits. The fresh
-- SDE mirror lives in the `public` schema's `sde_*` tables (nightly
-- sde-mirror workflow), so the dead schema goes to avoid any confusion
-- between the two.
--
-- Destructive by design: the stale data has no consumers and no other source
-- of truth to preserve.
drop schema if exists evesde cascade;
```

2. `schema.sql` needs **no** change — it never contained `evesde`.

3. `CLAUDE.md`: update the two rules that still tell agents to avoid a schema
   that no longer exists (if PR 1 of this series — the loader cutover — has
   already merged, these lines may already read differently; adapt):
   - In **# Data sources**, replace the "NEVER query the `evesde` SDE schema…"
     bullet with wording like: "The legacy `evesde` DB schema has been dropped
     (stale out-of-band data) — do not recreate or reference it. SDE lookups go
     through the `src/sde*.ts` loaders."
   - In **# Architecture**, the bullet starting "Avoid using the `evesde`
     schema…": remove the `evesde` references, keeping the rest of the bullet's
     content (where type lookups come from) intact.

## Done when

- `pnpm run lint` passes (only markdown/SQL changed, but run it anyway).
- The PR description states clearly that the migration is destructive to the
  stale schema by design and was explicitly requested.
