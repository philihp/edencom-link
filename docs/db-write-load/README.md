# Database size and write load — plan

Project `ifqywgxsdjxbonsytqya`, Postgres 17, 3.1 GB. The owner measured these
hot spots and asked for a plan before anything is deleted or dropped:

| Table                     | Size                        | Writes measured                          |
| ------------------------- | --------------------------- | ---------------------------------------- |
| `character_asset_version` | 142 MB (+15 MB dead)        | 14.4M updates against 72K inserts        |
| `corp_asset_over_time`    | 66 MB                       | 2.06M updates against 60K inserts        |
| `heartbeat`               | 286 MB (106 data, 179 index) | 405K rows since June, ~200K a month, never deleted |

Status: **Part A shipped, Part B declined.** A1 landed as #1095: the asset
reconciles no longer touch an unchanged row, a close stamps `valid_until` with
the run's clock (in the job and in the claim functions), and a held ship's
"last seen" is the owner's latest successful assets refresh. The owner declined
every Part B change: the heartbeats, their start rows and their indexes are
needed as they are, and a retention delete or an index swap there would have
broken readers downstream — so **B2 and B3 are not to be applied**. They stay
below only as the record of what was weighed and why it was wrong. B4 (the
hourly dens cadence) and the two index questions under Part A remain open for
the owner to decide; nothing in this document is to be run without that
explicit approval.

## A. Asset history: the touch is the write load

### What the 200 updates per insert are

Both reconciles (`src/jobs/characterAssets.js`, `src/jobs/corpAssets.js`)
compare each fetched item's signature with its open row and sort items into
three bins. Only two of them are changes:

| Bin       | Meaning                          | Write today                                    |
| --------- | -------------------------------- | ---------------------------------------------- |
| unchanged | same signature as the open row   | `update set valid_until = now` on the open row |
| changed   | signature differs                | close old row, insert new (via `*_asset_claim`) |
| new       | no open row                      | insert (via `*_asset_claim`)                   |
| vanished  | open row not in the listing      | `update set is_current = false`                |

So the writes are not an upsert that fails to compare. The compare already
happens in code (`signature()`), and the inserts go through the claim
functions, not `ON CONFLICT`. The 14.4M updates are the **touch**: every
unchanged item's open row gets its `valid_until` moved forward on every run,
every six hours, for every character. A hangar changes about half a percent
of its items per run, so the touch is ~200 row rewrites per real change.

The touch can never be a HOT update, because `valid_until` is a column of
`character_asset_version_item_id_idx (item_id, valid_until desc)` and of
`corp_asset_over_time_item_id_idx (item_id, valid_until desc)`. Every touched
row therefore writes a new heap tuple **and** new entries in all five (four
for corp) indexes, and leaves a dead tuple behind. That is the 15 MB of
bloat and the write load.

### What the touch buys, and who reads it

`valid_until` on an **open** row means "last extract that listed this item".
One reader uses that: the share page's sighting line
(`src/app/ship/[itemId]/lastSeen.ts`, `sharedShip.ts`), which reads a ship's
newest version row and says "last seen N ago", turning to the alert colour
after a day.

`valid_until` on a **closed** row means "last listed before it vanished or
changed". Readers:

- the time-travel predicate `valid_from <= as_of and (is_current or valid_until >= as_of)`
  in `character_asset_snapshot_at()` (the Sheets endpoint);
- `childrenAsOf()` in `sharedShip.ts`: what a vanished ship held is the set
  of rows linked to it with `valid_until >= the ship's valid_until`;
- the `parent_of` CTEs in `corp_asset_location_summary()`,
  `corp_asset_search()`, `corp_asset_filter()` and the character
  `asset_location_summary` cache rebuild, which pick one best-known parent per
  item by `order by is_current desc, valid_until desc`.

Note that closing a row today writes **only** `is_current = false` and leaves
`valid_until` at the last touch. That is what gives a closed row its meaning.

### Change A1 — stop touching; stamp `valid_until` on close instead

Both reconciles:

1. Drop the `touchIds` write entirely. An unchanged item costs no write.
2. Closing a row writes `{ is_current: false, valid_until: now }` — the moment
   the extract saw the item gone or changed, instead of the last moment it saw
   it present. The two differ by at most one extract interval (6h), which is
   the resolution the data has anyway; the market-prices job already closes
   rows this way (`src/jobs/marketPrices.js:61`).
3. The claim functions do the same for the cross-owner close: migration
   changes `character_asset_claim()` and `corp_asset_claim()` so their
   `update ... set is_current = false where is_current and item_id = any(v_items)`
   also sets `valid_until = now()`. (`schema.sql` lines ~911 and ~4571.)
4. The inserted row keeps `valid_until = now` from the payload, so an open
   row's `valid_until` equals its `valid_from`. It no longer means "last seen".

Readers after the change:

- Time travel: unchanged. A closed row is still valid until its close; an
  open row is `is_current`. The only observable difference is that a snapshot
  taken between an item's last sighting and the run that saw it gone now
  shows the item present (we had not yet seen it leave) rather than absent.
- `childrenAsOf()`: unchanged. A vanished ship and its contents close in the
  **same** run with the same `now`, so `valid_until >= lastSeen` still selects
  exactly what was aboard; contents that left earlier closed earlier.
- `parent_of` CTEs: unchanged (an open row wins; among closed, the latest
  close is the best-known parent).
- **Sighting line (`lastSeen.ts`): must change.** For an open ship, "last
  seen" becomes the owner's latest successful `character-assets` heartbeat
  (`heartbeat.ended_at where job = 'character-assets' and registration_id = ? and ok`),
  read on the service client `sharedShip.ts` already holds. For a closed
  ship, `valid_until` (the close) stands — within one interval of the truth.
  `sightingOf()` takes the heartbeat time as a parameter; the pure module and
  its test stay pure. The code comment in `lastSeen.ts` that documents the
  touch is rewritten.
- `schema.sql` comments at lines 741, 4489 ("valid_until is bumped each run")
  and the CLAUDE.md SCD-2 paragraph are updated to the new rule: **an open
  row's `valid_until` is its debut; a closed row's is its close; "last seen"
  is the owner's heartbeat.**

Expected effect: per run per character, one update per changed or vanished
item and one insert per changed or new item. On the measured ratio that is
roughly a 200× cut in row writes on `character_asset_version`, and ~35× on
`corp_asset_over_time`. Dead-tuple generation drops in proportion, and the
indexes stop churning (an insert writes them once; a close writes the two
that carry `is_current`/`valid_until`).

Files: `src/jobs/characterAssets.js`, `src/jobs/corpAssets.js`,
`src/app/ship/[itemId]/lastSeen.ts` (+ `test/lastSeen.test.ts`),
`src/app/ship/[itemId]/sharedShip.ts`, one migration (the two claim
functions), `schema.sql`, CLAUDE.md.

### Fallback A2 — keep the touch but make it HOT (not recommended)

If per-row "last seen" must stay: take `valid_until` out of both
`*_item_id_idx` (a plain `(item_id)` index serves the same lookups, with the
one `order by valid_until desc limit 1` in `sharedShip.ts` sorting a handful
of rows) and set `fillfactor = 85` on both tables. The touch then rewrites
the heap tuple but no index, and HOT pruning reclaims it without vacuum.
Still 14M heap writes per period; it halves the cost rather than removing
it. A1 is the real fix.

### Indexes

- `corp_asset_over_time_item_id_idx (item_id, valid_until desc)`, 18 MB,
  183 scans. Its only candidate users are the `parent_of` CTEs above, which
  sort by `(item_id, is_current desc, valid_until desc)` — the index matches
  the first column only, so the planner nearly always seq-scans the 66 MB
  table and sorts instead (hence 183 scans). **Propose: drop it**, after one
  `EXPLAIN` of `corp_asset_search` on production confirms the plan does not
  use it. Once A1 lands it no longer churns, so dropping is about the 18 MB,
  not writes. Needs approval.
- `character_asset_version_history_location_idx (location_id, valid_until desc) where not is_current`,
  2.5 MB, 5 scans. Serves the closed arm of `childrenAsOf()`: the share link
  that outlives the hull. Rare by nature; without it that page would scan
  every closed row of the table per render. It is partial on closed rows, so
  the touch never wrote it and A1 does not change it. **Propose: keep.**
- `character_asset_version_item_id_idx (item_id, valid_until desc)`: keep;
  serves `sharedShip.ts`'s newest-version lookup and `asset_ancestors()`.
  After A1 it is written on insert and close only.

### Same pattern elsewhere (not in scope, flagged)

Every SCD-2 extract uses the touch (`update({ valid_until: now })` in 13 job
modules). Two of them are larger than the asset tables in write terms:

- `market_price_over_time`: the hourly job touches every unchanged type —
  ~2 × 20k rows an hour, ~1M updates a day — because the CSV's `Updated`
  column reads `valid_until`. docs/market-prices/README.md already names the
  touch as the lever and sketches the fix (one "confirmed at" per market per
  run in a side table). Worth its own plan.
- `character_mercenary_den_over_time` + `character_mercenary_den_status`:
  hourly per den, see B4.

## B. `heartbeat`

### B1 — every reader, and how far back it looks

| Reader | File | Rows it needs | Lookback |
| --- | --- | --- | --- |
| `latest_heartbeats()` | `schema.sql` ~1795; `/jobs`, `/account/registrations` (`jobsData.ts`), MCP `dataFreshness` | latest completed per (job, owner) | **30 days** (hard floor in the SQL) |
| open runs | `jobsData.ts:75` | `ended_at is null`, started, `ran_at >= now − 1h` | 1 hour |
| five-minute rule | `src/jobs/ranRecently.js` | ended ok or still open within 5 min | 5 minutes |
| role-denial memory | `src/jobs/lib.js` `recentDenials` | `skipped_reason` rows for the job | 7 days |
| header "refreshed N ago" | `src/app/layout/header.tsx` | latest `ended_at` for `user_id` | latest only |
| `/asset` last run | `src/app/asset/page.tsx:47` | latest `character-assets` end | latest only |
| `/structure` last run | `src/app/structure/page.tsx:933` | latest `corp-structures` end | latest only |
| fittings archive `refreshedAt` | `src/app/api/fittings/route.ts:62` | latest `character-fittings` end per registration | latest only |
| canary | `src/heartbeat.js` | writes only | — |

**No page or job needs a row older than 30 days.** The "latest only" readers
would read "never" for a job that has not completed in 30 days, which is
what `latest_heartbeats()` already tells `/jobs` about such a job. The RLS
policy filters by owner, not time.

### B2 — retention: pg_cron, 30 days

Migration (new timestamp from the clock, per the Workflow rules):

```sql
create extension if not exists pg_cron;
grant usage on schema cron to postgres;

-- Idempotent: re-running the migration replaces the job rather than adding one.
select cron.unschedule(jobid) from cron.job where jobname = 'heartbeat-retention';

-- 04:35 UTC daily, off the hour and clear of the extract crons. ran_at is the
-- row's creation time and carries heartbeat_ran_at_idx, so the delete is an
-- index range scan. latest_heartbeats() floors at 30 days already, so no
-- reader can observe the difference.
select cron.schedule(
  'heartbeat-retention',
  '35 4 * * *',
  $$ delete from public.heartbeat where ran_at < now() - interval '30 days' $$
);
```

The first run removes roughly half the table (everything from June to early
September, ~200K rows) in one statement; a few seconds on this size. If the
owner prefers, that first purge is run by hand after approval and the cron
only keeps up (~6–7K rows a day at today's rate, under 1K a day after B4).
Then `VACUUM (ANALYZE) heartbeat` and the owner's `pg_repack`/`VACUUM FULL`
to return the space; the 179 MB of indexes shrink with the rows.

`schema.sql` gains the same `cron.schedule` so a reset reproduces it.

### B3 — one write per row? The start row is load-bearing

The row is written twice on purpose: `start` inserts it, `end` upserts
`ended_at`/`ok`/`error` onto the same key (`recordHeartbeat`,
`src/supabase.js:59`). Three things read the start half:

1. `/jobs` shows a scheduled run as **running** from the open row
   (`jobsData.ts:75`). `latest_heartbeats()` has completed rows only.
2. The five-minute rule treats an open row started within five minutes as a
   run in flight (`recentRun.js`), which is the second guard — behind
   `refreshCoalesce` — against two reconciles of the same character or corp
   running at once, the race that once corrupted the SCD-2 data.
3. A run the platform killed leaves an open row and nothing else; that is how
   a timeout becomes visible at all (see the note in
   `src/jobs/structureResolution.js`). Written once at the end, a killed run
   would leave no trace and read as "never ran".

So end-only writing loses live state, a safety guard and the failure signal.
**Not recommended.** The write cost of the pair comes from something
narrower: the `end` update is never HOT because `ended_at` sits in two
indexes, `heartbeat_job_ended_at_idx (job, ended_at desc)` and
`heartbeat_user_id_ended_at_idx (user_id, ended_at desc)`. Proposal instead:

**Make the end update HOT.** Migration:

```sql
-- ran_at is the row's creation time (the start). Ordering completions by it
-- instead of by ended_at changes the answer only when two runs of the same
-- cell overlap, which the five-minute rule prevents.
drop index public.heartbeat_job_ended_at_idx;
drop index public.heartbeat_user_id_ended_at_idx;
create index heartbeat_job_ran_at_idx     on public.heartbeat (job, ran_at desc);
create index heartbeat_user_id_ran_at_idx on public.heartbeat (user_id, ran_at desc);
-- Room on the page for the end update's new tuple version.
alter table public.heartbeat set (fillfactor = 70);
```

and `latest_heartbeats()` filters and orders on `ran_at` (`ran_at > now() - 30 days`,
`order by job, owner_key, ran_at desc`, still `where ended_at is not null`).
After that the end upsert changes only unindexed columns (`ended_at`, `ok`,
`error`, `skipped_reason`, the generated `duration`), so with page room it is
a HOT update: no index entries, dead version pruned on the page without
vacuum. Code changes, all one-line reorderings from `ended_at` to `ran_at`:
`header.tsx`, `asset/page.tsx`, `structure/page.tsx`, `api/fittings/route.ts`,
`ranRecently.js` (`gt('ran_at', since − 1h)` as the index predicate, the
`ended_at`/`started_at` tests stay as filters), `recentDenials`. Also drop the
two `(registration_id)` / `(corporation_id)` single-column indexes only if
`pg_stat_user_indexes` shows them idle; the RLS policy filters by `user_id`
and `corporation_id`, so I expect the corporation one is used. Needs the
owner's stats.

`runDirectCronJob` (`src/utils/cron.ts`) still closes rows without `ok`; it
should pass `ok: true`/`false` like the workflow wrapper, so no new
`ok = null` completed rows are written.

### B4 — why `character-mercenary-dens` writes 3× the rows

`vercel.json` schedules it hourly (`30 * * * *`); every other per-character
job runs every six hours. The cadence was raised for Discord reinforcement
detection (docs/discord-bot/04-reinforcement-detection.md "Detection
latency — cadence decision": a six-hourly pull pings up to 6h late on a
~1–1.5 day timer; docs/discord-bot/README.md records the bump). The scope it
needs, `esi-structures.read_character.v1`, is a default-on scope, so **every**
linked character runs hourly whether or not they hold a den or have a
Discord channel. That is 24 heartbeat rows per character per day against 4
for the other jobs — the 105K rows — plus, per den per hour, one touch on
`character_mercenary_den_over_time`, one appended
`character_mercenary_den_status` row and one extra ESI detail call.

Proposal: keep the hourly cron, make the hourly ticks selective.

- In the scheduled fan-out (`src/workflows/characterMercenaryDens.ts`), on
  ticks other than the six-hourly one (`:30` at hours 0/6/12/18, matching the
  other jobs' cadence) only dispatch registrations that have an open
  `character_mercenary_den` row **or** whose account has a linked Discord
  channel (`selectUserDiscordChannels` / the `discord_channel` table). A
  character with no dens and nobody listening has nothing hourly to detect.
  The filter runs in the enumerate step before `forEachCharacter`, so a
  skipped character writes no heartbeat at all (a skip inside the loop would
  still write the pair).
- Optional, same PR: append a `character_mercenary_den_status` row only when
  the observation differs from the den's latest row (state, levels,
  infomorphs, `reinforcement_end`). The dens page shows
  `status_observed_at` "N ago"; it would then read the last **change**, so
  pair it with the owner's heartbeat the way A1 does for ships, or leave the
  append as is and accept the rows (they are small).

Expected: heartbeat rows from this job fall from ~870 a day to the
six-hourly baseline plus a handful of hourly den-holders.

### `ok = null` rows (80,715)

Three sources: every row before migration `20260807020000_heartbeat_ok_error.sql`
added the column (two months of rows), runs that never wrote an end
(killed functions — the open rows `jobsData` already ages out after an hour),
and the two `runDirectCronJob` routes, which close without `ok`. B2 deletes
the first two kinds as they age past 30 days; B3's last paragraph stops the
third. Nothing reads `ok` on a row older than 30 days.

## Order of work

1. **A1** (code + claim-function migration) — the biggest write cut, no data
   deleted, no index dropped. Ship first and let a few cycles run.
2. **B3 + B4** — HOT end-updates and the selective hourly dens tick. Index
   swap is a drop-and-create of two small indexes (the table is 179 MB of
   indexes today; after B2 they are a fraction of that).
3. **B2** — retention. The first purge and the pg_cron schedule, on approval.
4. Owner: `pg_repack` / `VACUUM FULL` on `heartbeat`, `character_asset_version`,
   `corp_asset_over_time`; then `pg_stat_user_indexes` again to decide on
   `corp_asset_over_time_item_id_idx` and the two single-column heartbeat
   indexes.
5. Follow-up plan for `market_price_over_time`'s hourly touch (the largest
   remaining touch by far).
