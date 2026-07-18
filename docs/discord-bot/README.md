# Discord bot: reinforced-den notifications

Scope for making edencom.link double as a Discord application, so that when
an extract run detects that one of a user's Mercenary Dens has been
reinforced, a message is posted automatically to a Discord channel the user
configured. Today this is manual: the `/mercenary-dens` page has a 📋 button
(`src/app/mercenary-dens/copyDiscordPing.tsx`) that copies a Discord-ready
ping the user pastes into their corp channel themselves. This project closes
that loop.

This is a scoping document set, not an implementation spec. Each stage is
one PR with its own milestone; do them **in order** (each builds on the
previous). Stage docs deliberately stay at scoping depth — enough to size
and sequence the work — and the implementing PR should firm up the details
against the code as it stands then.

| Doc | PR | What | Milestone |
|---|---|---|---|
| [01-legal-pages.md](01-legal-pages.md) | tiny | Privacy policy + terms of service pages (Discord requires the URLs) | Pages live at `/privacy` and `/terms`, linked from the footer |
| [02-interactions-endpoint.md](02-interactions-endpoint.md) | small | Discord application registration + the signed interactions endpoint | Discord's developer-portal endpoint validation passes against production |
| [03-account-linking.md](03-account-linking.md) | medium | Bot install flow, account↔Discord linking, channel configuration via `/edencom link` | A linked channel row appears in settings after running the slash command |
| [04-reinforcement-detection.md](04-reinforcement-detection.md) | medium | Detect the unreinforced→reinforced transition at extract time; notification outbox table | A simulated reinforcement produces exactly one pending outbox row |
| [05-notification-sender.md](05-notification-sender.md) | small | Cron sweep that posts pending notifications to the linked channel | End-to-end: reinforced den → message in the Discord channel |

Follow-ups (out of scope for all five stages) are collected at the bottom of
this file.

## Why a bot and not just a webhook

The cheapest possible version of this is a Discord **incoming webhook**: the
user creates a webhook on their channel (two clicks in Discord's UI), pastes
the URL into `/account/settings`, and we POST to it — no application, no
interactions endpoint, no signature verification, no privacy-policy
requirement. That is a legitimate fallback if the bot route stalls, and
stages 04–05 are designed so the delivery target could be swapped without
touching detection.

The project still targets a real Discord **application/bot** because:

- Slash commands (`/edencom link`, later `/edencom dens`) make channel
  configuration self-serve inside Discord, where the corp already lives —
  no copying webhook URLs into a website.
- A bot identity can later *answer* questions (den status, timers) in
  channel, not just push.
- Webhook URLs are bearer secrets users paste around; a bot posting via its
  own token with per-channel rows we control is easier to revoke and audit.

## Architecture at a glance

```
Discord ──(signed POST)──▶ /api/discord/interactions ──▶ link/unlink channels
                                                              │
character-mercenary-dens extract ─▶ detects un→reinforced ─▶ notification outbox row
                                                              │
Vercel Cron (*/5) ─▶ /api/cron/discord-notification-send ─▶ POST Discord REST
                                                              │ (bot token)
                                                        linked channel message
```

Two independent halves meet at the outbox table:

- **Inbound** (stages 02–03): Discord calls us. The interactions endpoint is
  the only place Discord initiates contact; it verifies Ed25519 signatures
  and handles slash commands. This is where "endpoints that let Discord talk
  to the website" lives.
- **Outbound** (stages 04–05): we call Discord. Detection happens inside the
  existing `character-mercenary-dens` extract (which already appends one
  `character_mercenary_den_status` observation per den per run — the
  transition is visible by comparing consecutive observations), and a
  sweep job delivers pending rows via the Discord REST API.

## Relationship to the ntfy plan

[docs/ntfy-notifications.md](../ntfy-notifications.md) (unimplemented as of
this writing) designs a generic `notification` outbox delivered via ntfy.sh,
and explicitly lists mercenary-den reinforcement as a future source. This
project and that one want the same detection but different transports. The
outbox design decision — one shared table with a transport discriminator vs.
a Discord-specific table — is made in
[04-reinforcement-detection.md](04-reinforcement-detection.md); whichever
project lands first mints the table, and the other adds its transport.

## Discord platform prerequisites (why stage 01 exists)

Registering the application in the Discord developer portal asks for a
**Privacy Policy URL** and **Terms of Service URL**; they are mandatory for
app verification (required past 100 servers, and for any App Directory
listing) and are shown on the bot's profile and OAuth consent screen. We
want real pages before the app exists, hence legal pages first. The app
itself is expected to stay tiny (one corp's servers), so verification is not
an early concern — but the URLs are cheap and the site should have these
pages anyway.

New secrets (Vercel env vars + `.env.example`), introduced in stage 02:

- `DISCORD_APP_ID` — the application id (public, but env-configured)
- `DISCORD_PUBLIC_KEY` — verifies interaction signatures (public key, hex)
- `DISCORD_BOT_TOKEN` — authenticates outbound REST calls (secret)

## House rules (from CLAUDE.md — these bite)

- **No test runner.** Gates are `pnpm run lint` + `pnpm run build`, plus
  manually exercising the affected routes. Every PR must pass both.
- **Schema changes are dual-write**: edit `schema.sql` (full-reset source of
  truth) **and** add an incremental migration under `supabase/migrations/`
  (never rename an existing migration file).
- **Ramda over `for`/`while`** for synchronous iteration; sequential async
  iteration uses `forEachSequential` (`src/jobs/lib.js`).
- **Server components never call ESI directly** — and by extension, the
  Discord REST calls live in jobs/route handlers, never in page renders.
- **`git fetch origin && git rebase origin/main`** immediately before
  pushing and opening each PR.

## Follow-ups (explicitly out of scope for stages 01–05)

- `/edencom dens` slash command answering den status/timers in channel
  (needs the Discord-user→account mapping from stage 03 plus a carefully
  scoped service-role read, like the `/corpses` share page).
- Pre-timer reminders ("timer ends in 30 minutes") — a second outbox row
  scheduled at `reinforcement_end - interval`, cancelled if the den leaves
  reinforcement.
- Role mentions in the ping (`@dens` etc.) via `allowed_mentions` — needs
  per-channel config for which role to ping.
- Notifications for dens *shared to my corp* (the
  `character_mercenary_den_share` table), not just my own dens.
- Notifications from the enemy-den intel corkboard (user-submitted
  reinforcements, `enemyDenIntel.tsx`).
- Other notification sources riding the same outbox: industry-job
  completion (the ntfy plan), clone-jump cooldown, structure fuel.
- Incoming-webhook delivery as an alternative transport for users who don't
  want the bot in their server.
- Discord App Directory listing / verification.
