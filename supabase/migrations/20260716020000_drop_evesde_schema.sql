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
