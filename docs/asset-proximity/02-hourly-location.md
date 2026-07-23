# PR 2 — hourly `character-location` schedule

Make "where is the character right now" fresh to within an hour instead of
six. Everything already exists except the schedule:

- The job module `src/jobs/characterLocation.js` (`runCharacterLocation`,
  scope `esi-location.read_location.v1`) upserts one row per character into
  `character_location` and is already CLI-runnable and registered in the
  queue consumer's `JOBS` map (`src/app/api/queue/jobs/route.ts` —
  `'character-location'`).
- The 6-hourly `character-status` combo job already covers location (among
  wallet/implants/clones/ship); it stays untouched. Both jobs write the same
  upsert, so overlap is harmless.

ESI's `/characters/{id}/location/` is about the cheapest authed endpoint
there is — a three-field JSON body with a 5-second server cache — so hourly
per-character polling is negligible load on both ESI and our queue (one tiny
queue message per scoped character per hour).

## Changes

**New cron route** `src/app/api/cron/character-location/route.ts`, an exact
mirror of the existing per-character fan-out routes (copy
`src/app/api/cron/character-orders/route.ts` and adjust):

```ts
import { NextRequest, NextResponse } from 'next/server'

import { fanOutPerCharacterCronJob, requireCronSecret } from '@/utils/cron'

const SCOPE = 'esi-location.read_location.v1'

// Hourly location poll backing the /asset proximity sort (docs/asset-proximity/):
// fans out one queue message per scoped character. character-status still covers
// location every 6h; both do the same character_location upsert, so they overlap
// harmlessly — this route just tightens the freshness to ~an hour.
export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  const dispatched = await fanOutPerCharacterCronJob('character-location', SCOPE)

  return NextResponse.json({ ok: true, dispatched })
}
```

**`vercel.json`**: add a crons entry. Hourly, on a minute not used by the
6-hourly jobs (which sit at :07–:58 on their 6-hour marks); e.g.

```json
{ "path": "/api/cron/character-location", "schedule": "3 * * * *" }
```

Fan out to **all** scoped characters, not just mains: `is_main` can be
re-pointed at any time, an alt's location is useful the moment doc 03's
fallback (most recently recorded location) kicks in, and filtering the
fan-out would need a new `selectCharacterIdsWithScopes` variant for no real
saving.

## Deliberate non-changes (note these in the PR description)

- **No history table.** `character_location` stays a single upserted row per
  character. A `character_location_over_time` SCD table ("where does my main
  actually spend time?") is parked in the README's future-ideas list.
- **`/character/refresh` matrix unchanged.** The matrix shows
  `character-status`, which remains the on-demand/6-hourly umbrella. The
  hourly job still records per-character heartbeats (via
  `forEachCharacter`), so `latest_heartbeats()` reflects it; it just doesn't
  get its own matrix row.
- **Known side effect:** the header's "Refreshed N minutes ago" indicator
  shows the user's most recent extract heartbeat, so it will now read ≤ ~1h
  essentially always. Accepted — the data genuinely is that fresh — but
  worth a sentence in the PR body so it isn't mistaken for a freshness-
  grading bug.
- **No ETag plumbing.** The conditional-request machinery (`esi_etag`) is
  for skipping expensive reconciles; this endpoint's response is smaller
  than the bookkeeping.

## Gates

- `pnpm run lint` and `pnpm run build` pass.
- After deploy, hit the route once with the `CRON_SECRET` bearer to confirm
  fan-out (`{ ok: true, dispatched: N }`), then check `character_location.
  recorded_at` advances hourly and per-character `character-location`
  heartbeats appear.
