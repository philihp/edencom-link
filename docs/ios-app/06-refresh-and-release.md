# Phase 6 — Refresh ESI from the phone, and the release path

## Goal

Two things that make the app something a pilot uses every day rather than a
demo: a "Refresh" that pulls fresh ESI data for a character, and a build on
their phone through TestFlight, then the App Store.

## Refresh: the first GraphQL mutation

The schema has no `Mutation` type today; Links and the watch list are written
through server actions and MCP tools. Add one:

```graphql
type Mutation {
  "Start the on-demand refresh the website's Refresh ESI button starts: every per-character job for one character, or one named job. Coalesced, so a refresh already running is not started again."
  refresh(characterId: String!, job: String): RefreshReceipt!
}
type RefreshReceipt { started: [String!]!, coalesced: [String!]!, batchId: String }
```

- Resolver calls `dispatchRefresh` / `dispatchSingleJob`
  (`src/app/character/dispatchRefresh.ts`) with the caller's user id, after
  checking the character is theirs (the `registrationIds` from the context).
  The coalescing (`refreshCoalesce.ts`) applies as it does on the web, so a
  tapped-twice button starts nothing twice.
- **Session mode only.** An `api_token` bearer is refused with 403: a
  spreadsheet must not start ESI pulls. The mutation is the first
  session-only write; say so in `context.ts`'s header comment.
- MCP: do not expose it as a tool in this phase. The MCP server's write tools
  are deliberately few (CLAUDE.md); adding one is a separate decision.
- App: a "Refresh" action on the character card and the characters list;
  shows the receipt (started / already running) and re-queries after a delay
  while the per-job freshness dots update. `refresh_task` status is not
  exposed in GraphQL in this phase; the freshness stamps are enough to see the
  result.

## Release

Owner actions (README) must be done first: Apple Developer Program, an Expo
account, the bundle id, and the fixed OAuth client in Supabase.

- `mobile/eas.json` — profiles `development` (simulator, dev client),
  `preview` (internal distribution, ad hoc), `production` (store).
- `mobile/app.json` — name, slug, `ios.bundleIdentifier`, icon and splash
  (the CONCORD emblem favicon, #785, scaled; no new artwork), `scheme`,
  `ios.infoPlist` with `NSFaceIDUsageDescription` **only if** a later phase
  adds biometric lock (not in v1 — remove if unused).
- Secrets: `EXPO_TOKEN` in GitHub Actions → a `release.yml` workflow on
  `workflow_dispatch` and on tags `mobile-v*` that runs `eas build --platform
  ios --profile production --non-interactive` and `eas submit`. **Not on every
  PR**: a build costs minutes and EAS credits; the per-PR `mobile` job stays
  type-check and tests.
- Versioning: `mobile/package.json` `version` is the marketing version;
  `eas.json` `autoIncrement` handles the build number.
- App Store privacy labels: the app reads account data (EVE assets, wallet,
  jobs, orders) linked to the user, no tracking, no third-party analytics
  (`@vercel/analytics` is web-only and not in `mobile/`). Images come from
  `images.evetech.net`. Write this in `mobile/PRIVACY.md` so the store form
  is filled from one place.
- Sign-in review: Apple requires that an app with third-party login offers
  "Sign in with Apple" **when** it offers other social logins in the app
  itself. The app offers one button that opens the website; the choice of
  provider happens on the website. Note this in the review notes, and be
  ready to add Apple as a Supabase provider on the website if review asks —
  that is a website change, not an app change.

## Done when

- Tapping Refresh on a character flips its freshness dots to green within one
  extract cycle, and a second tap within five minutes reports "already
  running" (the five-minute rule in `src/jobs/ranRecently.js`).
- A TestFlight build installs on the owner's phone from a fresh install,
  signs in, and shows phases 3–5's screens.
- `release.yml` runs green once by `workflow_dispatch`.

## After this plan (not scheduled)

- **Ship screen with stats**: a server endpoint that runs the dogma engine for
  a ship (or a fit) and returns the readout, or a WebView of `/ship/[id]`.
- **Universal links**: `edencom.link/ship/<id>?share=…` opens in the app via
  Associated Domains, with the share page's opsec rules unchanged.
- **Push**: APNs through `expo-notifications`, a `device_token` table, and a
  sender in the notification sweep beside ntfy.
- **Structures, cost indices, contracts, wallet transactions**: each is one
  schema field plus one list screen, in the shape of phase 5.
- **Android**: Expo makes it mostly configuration; the OAuth redirect scheme
  and the store listing are the real work.
