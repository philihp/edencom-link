# Stage 05 — Sender sweep: outbox → Discord channel

**PR size:** small · **Depends on:** 03 + 04 · **Completes the MVP**

## Goal

A cron sweep that posts pending `transport = 'discord'` outbox rows to
their linked channels via the Discord REST API. After this stage the
end-to-end loop is closed: den reinforced → extract detects → message
appears in the corp channel.

## The job — `discord-notification-send`

Follows the extract-job conventions (name = npm script = heartbeat label =
cron path) even though it reads our own DB, exactly like the ntfy plan's
sender:

- **`src/jobs/discordNotificationSend.js`** exporting
  `runDiscordNotificationSend()`, CLI-runnable via `cli(...)`. Logic
  (ramda style, `forEachSequential`):
  1. `sudoSupabase` select due rows: `transport = 'discord'`,
     `sent_at is null`, `scheduled_at <= now()`, `attempts < 10`, joined to
     `discord_channel` for the target (skip rows whose channel is
     `disabled_at`-stamped or deleted — bump attempts so they eventually
     stop being selected).
  2. Per row: `POST https://discord.com/api/v10/channels/{channel_id}/messages`
     with `Authorization: Bot ${DISCORD_BOT_TOKEN}`, body
     `{ content: row.body, allowed_mentions: { parse: [] } }` (no pings of
     any kind until role-mention config exists — the timestamp markup does
     the urgency work).
  3. Outcome handling:
     - **2xx** → stamp `sent_at = now()`.
     - **403/404** (bot kicked, channel deleted, permissions revoked) →
       stamp the `discord_channel.disabled_at` and bump `attempts`; these
       are permanent, don't burn 10 retries. Settings UI shows the channel
       as disabled so the user can re-link.
     - **429** → respect `retry_after` from the response body within reason
       (sequential sends at this volume make real rate-limiting unlikely);
       otherwise bump `attempts` and let the next sweep retry.
     - other failure → bump `attempts` (cap 10, then abandoned-but-visible,
       per the ntfy design).
  4. Per-run summary log line + a `discord.send` metric via
     `src/observability.js` (`{ metric, outcome, status, duration_ms }`),
     matching the `esi.conditional_request` precedent.
- **Cron route** `src/app/api/cron/discord-notification-send/route.ts` —
  `requireCronSecret` + `runDirectCronJob` (the direct dispatch shape:
  tiny working set, nothing to fan out, heartbeat for free).
- **`vercel.json`**: `*/5 * * * *`. Five-minute delivery lag on top of
  detection is noise against the extract cadence.
- **`package.json`**: `"discord-notification-send": "node src/jobs/discordNotificationSend.js"`.

Not on `/character/refresh`'s matrix (not per-character, not an ESI
extract); the heartbeat row still proves liveness.

## Settings polish riding along

- A **"Send test message"** button per linked channel in the Discord
  settings section — server action that posts directly (not via the outbox)
  so users verify the pipe before trusting it. Mirrors the ntfy plan's
  test-notification button.
- Linked-channel list shows `disabled_at` state ("bot lost access — remove
  and re-link").

## Milestone / acceptance

- `pnpm run lint` + `pnpm run build` pass.
- Hand-insert a pending outbox row (or run the stage-04 simulation) → the
  message appears in the linked test channel within one sweep, rendered
  with Discord's live countdown; the row is `sent_at`-stamped; re-running
  the sweep sends nothing.
- Kick the bot from the test server, enqueue again → channel row gets
  `disabled_at`, no crash-looping, settings shows the state.
- Test button works; a message to a channel the bot can't see fails
  gracefully.

## Out of scope (see README follow-ups)

- Embeds/rich formatting (plain content with timestamp markup is already
  the format the corp uses).
- Role mentions, per-event channel routing, reminders before timer end,
  `/edencom dens` query command, shared-den notifications.
