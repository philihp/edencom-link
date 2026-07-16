# Plan: industry-job completion notifications via ntfy.sh

Push a notification to the user's phone/desktop when an industry job they
care about finishes. Delivery rides on [ntfy.sh](https://ntfy.sh) — a
publish/subscribe push service where publishing is just an HTTP POST — so we
never touch APNs/FCM/web-push plumbing ourselves. The user opts in per job
with a toggle on the Industry page; opting in schedules a notification for
the job's `end_date`, persisted as a row in a new `notification` table.

## How ntfy.sh works (the 30-second version)

- A **topic** is a plain string that acts as both channel name and shared
  secret. Anyone who knows it can publish to it and subscribe to it; there is
  no registration step. The docs therefore recommend a hard-to-guess topic.
- **Subscribing:** the user installs the ntfy app (iOS/Android/web/CLI) and
  subscribes to their topic. That's all the client-side setup there is.
- **Publishing:** `POST https://ntfy.sh/<topic>` with the message as the
  request body. Optional headers: `Title` (subject line), `Click` (URL opened
  on tap), `Tags` (emoji), `Priority`, `Icon`.

```
curl -H "Title: Industry job complete" \
     -H "Click: https://edencom.link/industry" \
     -H "Tags: hammer" \
     -d "Manufacturing: 10 runs of Hobgoblin I finished at 1DQ1-A" \
     https://ntfy.sh/edencom-4f3a9c1b2d8e
```

### Why we schedule in our own DB rather than ntfy's native delayed delivery

ntfy supports scheduled sends (`X-Delay` / `At` headers), which is tempting —
POST once at toggle time and let ntfy hold the message. Two dealbreakers:

1. **The default delay cap is 3 days** (`message-delay-limit`); plenty of
   industry jobs (long reactions, capital builds, high-run invention) exceed
   it.
2. **There is no cancel API.** The whole point of the toggle is that it can
   be flipped back off; a message already handed to ntfy would fire anyway.

So the `notification` table is the scheduler: a row is created when the
toggle turns on, deleted if it turns off before firing, and a small sweep job
publishes rows whose time has come. This also happens to be exactly the table
shape requested (subject, body, scheduled time, sent time).

## Design at a glance

```
Industry page toggle ──(server action)──▶ notification row (sent_at null)
                                               │
Vercel Cron (*/5) ─▶ /api/cron/notification-send ─▶ due rows ─▶ POST ntfy.sh/<topic>
                                               │                     │
                                               └── sent_at stamped ◀─┘ (2xx)
```

A job's `end_date` is known the moment ESI reports the job, so the send time
never depends on extract freshness — the 6-hourly `character-industry-jobs`
cadence doesn't delay the ping. The only freshness-sensitive part is the
sweep interval itself.

## 1. Schema

Per the repo rule, both `schema.sql` (edit in place, keeping the full-reset
property) **and** an incremental migration (`pnpm run db:new
add_notification`) change together.

### New table `notification`

Deliberately generic — nothing industry-specific in the columns — so future
sources (mercenary den reinforcement timers, clone-jump cooldowns, structure
fuel) reuse it by minting new `source` prefixes.

```sql
-- ── notification ──────────────────────────────────────────────────────────
-- Scheduled push notifications, delivered via ntfy.sh to the topic in
-- user_settings.ntfy_topic. A row is created when the user opts in (e.g. the
-- per-job toggle on /industry), sits pending until scheduled_at, and is
-- stamped sent_at once the notification-send sweep publishes it. Toggling
-- off before the send deletes the pending row. `source` identifies what the
-- notification is about ('industry-job:<job_id>'), giving the UI a key to
-- find/dedupe pending rows.
create table public.notification (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null,                        -- e.g. 'industry-job:551799423'
  subject text not null,                       -- ntfy Title header
  body text not null,                          -- ntfy message body
  scheduled_at timestamptz not null,           -- when it should fire (job end_date)
  sent_at timestamptz,                         -- when it actually went out; null = pending
  attempts int not null default 0,             -- failed publish tries (sweep gives up past a cap)
  created_at timestamptz not null default now()
);

-- One *pending* notification per source per user; history rows (sent) don't
-- block re-scheduling the same source later.
create unique index notification_pending_source_idx
  on public.notification (user_id, source)
  where sent_at is null;

-- The sweep's working set.
create index notification_due_idx
  on public.notification (scheduled_at)
  where sent_at is null;

alter table public.notification enable row level security;
create policy "Users manage own notifications"
  on public.notification
  for all
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

grant select, insert, update, delete on public.notification to authenticated;
grant all                            on public.notification to service_role;
```

Field-naming note: the request asked for "the time it was scheduled" — this
lands as **two** columns to cover both readings: `scheduled_at` (the time it
is scheduled *to send*, i.e. the job's `end_date`) and `created_at` (the time
the scheduling happened). `sent_at` is the time it was sent.

### `user_settings.ntfy_topic`

```sql
alter table public.user_settings add column ntfy_topic text;
```

Null means notifications are off account-wide (toggles render disabled with a
pointer to settings). The topic is treated like the existing `api_token`: an
opaque secret the user can generate/rotate in settings. MVP pins the server
to `https://ntfy.sh`; a self-hosted `ntfy_url` + access-token column is a
listed follow-up, kept out of scope for now.

## 2. Publish helper — `src/utils/ntfy.ts`

One tiny module so the sweep job and the settings "send test" button share
identical behavior:

```ts
export const publishNtfy = async (
  topic: string,
  { subject, body, click }: { subject: string; body: string; click?: string }
): Promise<{ ok: boolean; status: number }> => { /* fetch POST, headers above */ }
```

- No retry logic here — the sweep owns retries (via `attempts`).
- Never throws on non-2xx; returns status so callers decide.
- Emits an `ntfy.publish` metric line via `src/observability.js`
  (`{ metric, outcome, status, duration_ms }`), matching the
  `esi.conditional_request` precedent, so delivery health is queryable in
  Vercel Observability.

## 3. Settings UI — `/account/settings`

New "Notifications" section (component `ntfyTopic.tsx`, patterned on
`apiToken.tsx`):

- Shows the current topic or a **Generate topic** button
  (`edencom-` + `randomBytes(8).toString('hex')`, minted server-side like
  `generateApiToken`).
- Short blurb + link: "Install the ntfy app and subscribe to this topic.
  Anyone who knows the topic can see your notifications — treat it like a
  password." Rotate button regenerates it.
- **Send test notification** button → server action that calls `publishNtfy`
  immediately (not via the table), so the user can confirm the pipe end-to-end
  before trusting it with a 3-week capital build.

Server actions live in the existing `src/app/account/settings/actions.ts`.

## 4. Industry page toggle

### Data in (`src/app/industry/page.tsx`)

Alongside the existing parallel fetches, read the signed-in user's pending
industry notifications (RLS scopes it automatically):

```ts
supabase.from('notification').select('source')
  .is('sent_at', null).like('source', 'industry-job:%')
```

…plus `user_settings.ntfy_topic` (null ⇒ toggles disabled). Pass
`notifiedJobIds: Set<string>` and `ntfyConfigured: boolean` into
`ActiveJobs`.

### UI (`src/app/industry/activeJobs.tsx`)

New **Notify** column (last, after Remaining). Each row gets a slider-styled
checkbox — a plain `<input type="checkbox">` wrapped in a `<label>` with
track/thumb CSS added to `industry.module.css` (the codebase has no existing
switch component; CSS-only keeps it dependency-free and matches the retro
table styling).

- Checked ⇔ a pending notification row exists for that `job_id`.
- Optimistic flip via `useState`, then the server action; revert + surface
  the error message on failure.
- When `ntfyConfigured` is false, render the column with disabled toggles and
  a header link to `/account/settings` ("set up ntfy first").
- Jobs whose `end_date` is already past ("ready") render the toggle disabled —
  nothing left to schedule.

### Server action (`src/app/industry/actions.ts`, new file)

```ts
'use server'
export const setJobNotification = async (jobId: string, enabled: boolean) => { ... }
```

On **enable**:

1. Auth via `createClient()` (cookie session); bail if signed out.
2. Re-fetch the job by `job_id` from `character_industry_job` /
   `corp_industry_job` **through the user's own RLS-scoped client** — this is
   the authorization check that the job is really theirs to watch (never
   trust the client's row data).
3. Reject if `end_date` is already past.
4. Compose the snapshot:
   - `subject`: `Industry job complete`
   - `body`: `<Activity>: <runs> runs of <product type name> finished at
     <station/structure name>` — activity from `ACTIVITY_NAMES`, type name
     via `getSdeType`, location via the same resolution the page already did
     (pass the display name from the client as a *hint only* — recompute
     server-side).
   - `scheduled_at`: the job's `end_date`.
   - `source`: `industry-job:<job_id>`.
5. Insert; the partial unique index makes a double-toggle race a no-op
   (`on conflict` isn't available via supabase-js upsert on a partial index,
   so treat the `23505` duplicate error as success).

On **disable**: delete the user's pending row
(`.eq('source', ...).is('sent_at', null)`). Already-sent rows stay as
history. Finish with `revalidatePath('/industry')`.

Corp jobs need no special casing: the toggle is **per-user** — whoever flips
it gets the ping on *their* topic — and RLS on `corp_industry_job` already
answers "may this user watch this job".

## 5. Sender job — `notification-send`

Follows the extract-job conventions (name = npm script = heartbeat label =
cron path) even though it reads our own DB rather than ESI:

- **`src/jobs/notificationSend.js`** exporting `runNotificationSend()`,
  self-runnable via `cli(import.meta.url, TAG, run)`. Logic (ramda style, no
  `for`/`while`):
  1. `sudoSupabase` select due rows: `sent_at is null`, `scheduled_at <=
     now()`, `attempts < 10`, joined to `user_settings` for each row's
     current `ntfy_topic` (read at send time, so rotating the topic applies
     to pending rows).
  2. `forEachSequential` over rows: no topic ⇒ bump `attempts` and skip;
     otherwise `publishNtfy`. 2xx ⇒ stamp `sent_at = now()`; failure ⇒
     increment `attempts` (next sweep retries; cap 10 ≈ 50 minutes of
     retries, then the row is abandoned — visible in the table, `sent_at`
     null).
  3. Log a per-run summary line (sent/failed/skipped counts).
- **Cron route `src/app/api/cron/notification-send/route.ts`** —
  `requireCronSecret` + `runDirectCronJob(TAG, runNotificationSend)` (the
  direct shape: the working set is tiny, there is nothing to fan out, and the
  heartbeat gives `/character/refresh`-style liveness for free).
- **`vercel.json`**: `{ "path": "/api/cron/notification-send", "schedule":
  "*/5 * * * *" }`. Every 5 minutes bounds notification lateness at ~5 min,
  which is fine for jobs measured in hours/days. (Per-minute cron needs
  Vercel Pro — this project's 18 existing sub-daily crons imply Pro already;
  if invocation volume is a concern, `*/15` is an acceptable first setting.)
- **`package.json`**: `"notification-send": "node src/jobs/notificationSend.js"`.

Not queue-dispatched and not on `/character/refresh`'s matrix: it's neither
per-character nor an ESI extract, and there's no user-facing reason to kick
it manually (the heartbeat row still shows it's alive).

## 6. Edge cases & accepted limitations (MVP)

- **Paused jobs**: pausing shifts the real completion time, but the
  notification keeps the `end_date` snapshot taken at toggle time — it may
  fire early. Acceptable for v1; a follow-up could have
  `character-industry-jobs`' reconcile re-stamp pending rows when it opens a
  new SCD version of a watched job.
- **Job delivered/cancelled early**: the notification still fires at
  `end_date`. For manufacturing, `end_date` *is* completion (delivery is just
  pickup), so this is usually correct anyway. A cancelled job produces one
  stale ping; the user can toggle off first.
- **Topic deleted/rotated between toggle and send**: topic is read at send
  time, so rotation redirects pending pings; clearing the topic strands them
  (they exhaust attempts and stop). Fine.
- **ntfy.sh outage**: attempts/retry via the 5-minute sweep absorbs blips; a
  long outage burns the 10-attempt cap. The `ntfy.publish` metric makes this
  visible.
- **Duplicate sends**: the sweep runs in a single cron invocation every 5
  minutes and stamps `sent_at` per row right after each 2xx; overlapping
  invocations are not a realistic concern at this cadence/volume (and the
  worst case is a duplicate push, not data corruption).
- **Table growth**: sent rows accrete as history (the request explicitly
  wants `sent_at` recorded). Volume is tiny; if it ever matters, sweep rows
  older than ~90 days inside `notification-send`.

## 7. Suggested PR split

1. **PR 1 — plumbing**: schema.sql + migration (`notification`,
   `user_settings.ntfy_topic`), `src/utils/ntfy.ts`, settings UI section with
   generate/rotate/test. Independently shippable and lets users set up their
   ntfy app early.
2. **PR 2 — sender**: `src/jobs/notificationSend.js`, cron route,
   `vercel.json` + `package.json` entries. Verifiable by hand-inserting a row.
3. **PR 3 — the toggle**: industry page fetch, `ActiveJobs` Notify column +
   slider CSS, `setJobNotification` server action.

Each PR: `pnpm run lint`, `pnpm run build`, and for PR 1 apply the migration
via the `Migrate` workflow on merge (or `pnpm run db:push`).

## 8. Explicitly out of scope (candidate follow-ups)

- Self-hosted ntfy servers (`ntfy_url` + access-token columns, `Authorization`
  header in `publishNtfy`).
- "Notify me for **all** jobs" account-level default, or auto-toggling jobs
  the user installs going forward.
- Other notification sources: mercenary-den reinforcement (`reinforcement_end`
  is already extracted), clone-jump cooldown, structure fuel — each is just a
  new `source` prefix plus a scheduling hook.
- Re-stamping `scheduled_at` when the extract observes a changed/paused job.
- An MCP tool to list/schedule notifications.
