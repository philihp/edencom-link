# Stage 03 — Bot install, account linking, channel configuration

**PR size:** medium (the schema + UI stage) · **Depends on:** 02 ·
**Blocks:** 04 (detection needs to know someone is listening), 05

## Goal

A signed-in edencom.link user can (a) invite the bot to their Discord
server, (b) prove to the bot which edencom.link account they are, and
(c) pick the channel that gets den pings — all via one slash command run in
the target channel. After this stage, `/account/settings` shows the linked
channel(s); nothing posts to them yet.

## Design: linked identity first, link codes as fallback

*(Amended 2026-08-01: this stage originally ruled out Discord OAuth. Stage
06 now brings Discord sign-in via Supabase Auth, so a growing share of
accounts carry a Discord identity — `auth.identities` holds the Discord
user id. When the `/edencom link` invoker's Discord user id matches a
linked identity (service-role lookup), bind the channel to that account
directly, no code needed. The link-code flow below stays as the fallback
for accounts without a Discord identity, and the two flows share the same
`discord_channel` row shape. If 06 lands first, the implementing PR for
this stage may make codes a follow-up rather than building both paths.)*

Two identities need joining: the edencom.link account (Supabase `user_id`)
and a Discord channel. The code-based flow mirrors the invite-code pattern
the repo already has (`invite_code`):

1. Settings page mints a short-lived, single-use **link code** (server
   action; `randomBytes` like `generateApiToken`), shown with copy button
   and the bot-install link.
2. User clicks the install link (`https://discord.com/oauth2/authorize?client_id=<DISCORD_APP_ID>&scope=bot+applications.commands&permissions=<perms>` —
   permissions: Send Messages + Embed Links only; request nothing else) and
   adds the bot to their server.
3. In the channel that should receive pings, user runs
   `/edencom link <code>`. The interaction carries the guild id, channel id,
   and the invoking Discord user's id — everything needed to bind.
4. The interactions handler (service-role client, after signature
   verification) burns the code and inserts the channel link row. Ephemeral
   confirmation reply.

`/edencom unlink` in the same channel removes the row; the settings page
also lists links with a remove button (belt and braces — the user may have
lost access to the Discord server).

## Schema (dual-write: `schema.sql` + migration)

Two tables, names indicative — final shapes belong to the implementing PR:

- **`discord_link_code`** — `code` (unique), `user_id`, `created_at`,
  `expires_at` (~10 min), `redeemed_at`. RLS: owner reads own; inserts via
  server action; redemption via service role.
- **`discord_channel`** — `id`, `user_id`, `guild_id`, `channel_id`,
  `guild_name`, `channel_name` (display only, denormalized at link time from
  the interaction payload), `linked_by_discord_user_id`, `created_at`,
  `disabled_at` (stage 05 sets this when Discord says the channel is gone).
  Unique `(user_id, channel_id)`. RLS: owner reads/deletes own rows; writes
  via service role only (the interactions route is the writer).

Keeping `discord_channel` per-**user** (not per-corp) matches the ntfy
plan's stance: whoever links, their dens ping there. Multiple users may link
the same channel; each binding is independent.

## Slash command registration

Commands are data registered with Discord, not code: a one-off utility
script (`src/discordRegisterCommands.js`, alongside `connect`/`ping`/
`refresh` in the DB/token-utilities family, run manually via
`node src/discordRegisterCommands.js`) that PUTs the global command list
(`/edencom` with `link <code>` and `unlink` subcommands) to
`applications/{DISCORD_APP_ID}/commands` using the bot token. Global
commands can take up to ~1h to propagate; the script should also support a
`--guild <id>` flag for instant registration on a test server.

## Interactions handler additions (`src/app/api/discord/`)

Replace stage 02's stub type-2 response with a small command router:

- `link`: validate code (exists, unexpired, unredeemed) → insert
  `discord_channel` → mark code redeemed → ephemeral success naming the
  channel. Failure modes get distinct ephemeral messages (expired code,
  already linked, …). All comfortably inside the 3-second budget.
- `unlink`: delete rows for this channel where `linked_by_discord_user_id`
  matches the invoker (or any row if the invoker owns the link code trail —
  keep it simple: match on channel + invoking Discord user).

## Settings UI (`/account/settings`)

New "Discord" section (pattern: the existing `apiToken.tsx` component):
install-bot link, generate-code button with countdown, list of linked
channels (`guild_name` / `#channel_name`, linked date, remove button).
Server actions in the existing settings `actions.ts`.

## Milestone / acceptance

- `pnpm run lint` + `pnpm run build` pass; migration applies.
- On a test Discord server: install bot → generate code → `/edencom link`
  → ephemeral confirmation → the channel appears in `/account/settings`;
  remove from settings and via `/edencom unlink` both work.
- An expired or reused code gets a clear ephemeral error.

## Out of scope

- Choosing *which* events go to *which* channel (all den reinforcements to
  every linked channel is the MVP; per-den or per-event routing is a
  follow-up).
- Discord OAuth2 website sign-in (now stage 06).
- Role-mention configuration.
