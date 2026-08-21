# Stage 02 — Discord application + interactions endpoint

**PR size:** small · **Depends on:** 01 (portal wants the legal URLs) ·
**Blocks:** 03 (slash commands arrive through this endpoint)

## Goal

Register the Discord application and stand up the one route Discord calls
into us: `POST /api/discord/interactions`. After this stage the app exists,
the endpoint passes Discord's validation, and every interaction type gets a
polite "not implemented yet" — the plumbing that lets Discord talk to the
website, with no behavior behind it.

## Portal setup (manual, documented in the PR description)

1. Create the application at discord.com/developers → note the
   **Application ID** and **Public Key**; add the stage-01 URLs in App
   Information.
2. Bot tab → create the bot user, note the **Token**. No privileged gateway
   intents — this bot never connects to the gateway at all (HTTP-only
   interactions + REST), which keeps hosting serverless-friendly on Vercel.
3. Set **Interactions Endpoint URL** to
   `https://edencom.link/api/discord/interactions`. Discord immediately
   fires a `PING` and several deliberately invalid-signature probes; the
   save only succeeds if we answer the PING correctly **and** reject the bad
   signatures with a 401. (This means the route must be deployed before the
   URL can be saved — deploy first, configure second.)
4. Vercel env vars + `.env.example` entries: `DISCORD_APP_ID`,
   `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_TOKEN` (token unused until stage 05
   but set it now while in the portal).

## The route — `src/app/api/discord/interactions/route.ts`

- **Node runtime** (not edge): we need `node:crypto` and, later, the
  service-role Supabase client.
- **Signature verification first, before anything else.** Discord signs
  every request: headers `X-Signature-Ed25519` and `X-Signature-Timestamp`;
  the signed message is `timestamp + rawBody`. Verification needs the **raw
  body string** — read `await request.text()` and `JSON.parse` manually;
  never let anything consume the body as JSON first. Invalid signature ⇒
  `401` with no body processing.
- **Ed25519 verification, zero-dependency:** Node 24's `node:crypto`
  verifies Ed25519 natively — import the hex `DISCORD_PUBLIC_KEY` as a raw
  key (via a one-line JWK wrap: `{ kty: 'OKP', crv: 'Ed25519', x:
base64url(hexToBytes(key)) }`) and `crypto.verify(null, message, key,
sig)`. This matches the repo's zero-dependency preference
  (`src/observability.js` precedent). Fallback if the raw-key import proves
  fiddly: the official `discord-interactions` npm package is tiny and does
  exactly this — acceptable, but try without it first.
- **Dispatch by interaction `type`:**
  - `1` (PING) → `{ type: 1 }` (PONG). This is what portal validation
    exercises.
  - `2` (APPLICATION_COMMAND) → for now, type-4 ephemeral response
    ("Nothing here yet — commands arrive in a later release"). Stage 03
    replaces this with the real command router.
  - anything else → type-4 ephemeral or 400.
- **Respond within 3 seconds** — Discord's hard deadline for the initial
  interaction response. Nothing in this stage comes close, but stage 03's
  handlers must keep DB work inside that budget (or defer with a type-5
  acknowledge; note it as a constraint, don't build deferral yet).
- Helper seam: put verification + response helpers in
  `src/app/api/discord/lib.ts` so stage 03's command handlers and any
  future routes share them.

No schema changes in this stage. Consider an `discord.interaction` metric
line via `src/observability.js` (`{ metric, type, outcome }`) from day one —
it makes the stage-03 debugging loop visible in Vercel Observability.

## Milestone / acceptance

- `pnpm run lint` + `pnpm run build` pass.
- The Discord developer portal accepts the Interactions Endpoint URL
  against production (its validation probes pass — this is the real test,
  and it's binary).
- A hand-crafted unsigned `curl` to the route gets a 401.

## Out of scope

- Any actual command behavior (stage 03).
- Gateway/websocket presence, message-content intent, DMs.
- Outbound REST calls (stage 05).
