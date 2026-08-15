-- Remember that nobody could resolve a structure, so the universe-structures
-- job stops re-asking every token about it every night.
--
-- The job pools candidate structure ids from every location column we extract
-- and tries each against every token carrying esi-universe.read_structures.v1,
-- because a structure needs only one character with docking access and that is
-- rarely the character whose assets sit there. With ~860 candidates and ~77
-- tokens that is up to ~66,000 ESI calls per pass, and a failure was never
-- recorded — so the same mostly-unresolvable set came back the next night, and
-- the next. In practice the pass blew ESI's error budget (420s), then ran until
-- Vercel killed the function at 800 seconds. A timeout writes no end heartbeat,
-- so latest_heartbeats() never saw the run at all and /jobs reported the job as
-- stale while it was in fact running, and dying, daily.
--
-- unresolved_at is the timestamp of the last pass that got a definitive "no"
-- from ESI about this structure — 403 (this character cannot dock) or 404 (no
-- such structure). Only those two: a 420 or a 5xx says nothing about the
-- structure, and caching one would silence a resolvable structure for a week.
--
-- Deliberately a pause, not a blacklist. Docking access does get granted, so the
-- job ignores marks older than its TTL (7 days, UNRESOLVED_TTL_DAYS in
-- src/jobs/structureResolution.js) and a successful resolve clears the column.
--
-- Nullable with no default: null means "never established as unresolvable",
-- which is the correct reading of every existing row, including the ids the
-- structure-directory job seeds from ESI's public list with no name yet.
alter table public.universe_structure
  add column if not exists unresolved_at timestamptz;

-- The candidate query asks for nameless rows parked within the TTL. Partial, so
-- it indexes only the parked rows rather than every structure we have ever seen.
create index if not exists universe_structure_unresolved_at_idx
  on public.universe_structure (unresolved_at)
  where unresolved_at is not null;
