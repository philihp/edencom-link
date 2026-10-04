# iOS app — EDENCOM Link on the phone, with React Native and Expo

> **Planned.** Nothing here is built yet. These documents are the project plan
> for a native iOS app under `mobile/`, written to be executed phase by phase
> in later sessions, possibly by a cheaper model. Each phase names the files it
> touches, what "done" is, and the invariants it must not break.
>
> **There was no earlier plan.** The repository, its full history (including
> deleted files and every branch), its issues and its pull requests hold no
> iOS, React Native or Expo plan (checked 2026-10-04). The only mobile work so
> far is responsive CSS (#432) and an iOS device frame used in a web mockup
> (`docs/registrations-page/design/ios-frame.jsx`). So this plan starts from
> what the web app already is, not from an older design.

## Goal

A pilot opens the app on their phone and gets, in under two seconds and
without signing in again: who their characters are and what state they are in
(ISK, place, ship, clone, data freshness), where an item is ("do I have X, and
where"), which industry jobs finish soon, and which market orders are open.
The app is a **client of the existing deployment**. It adds no data path of
its own.

## Hard constraints

1. **One data API: GraphQL.** The app reads only `POST /api/graphql`
   (`src/app/api/graphql/`). It never talks to PostgREST, ESI, or the
   `sde_*` mirror directly. A screen that needs a field GraphQL lacks gets the
   field **added to the schema**, where Links, the editor and MCP `run_query`
   gain it too. The one exception is images: `images.evetech.net` is public and
   is read directly, as the web app does.
2. **One sign-in: the website's.** The app signs in through Supabase Auth's
   OAuth 2.1 server with PKCE — the same authorization server the MCP endpoint
   already uses, with the same consent page (`/oauth/consent`). The pilot
   signs in on the website inside the system auth sheet, so every way in the
   site has — email, EVE SSO, Discord, GICE — works in the app with **no new
   auth code**. The app never holds a password, an ESI token or the
   `api_token`.
3. **Row-level security applies.** The access token the app holds is a
   Supabase JWT. The server verifies it with `getClaims()` (as
   `src/app/api/mcp/auth.ts` does) and runs the request on a bearer client
   (`src/utils/supabase/bearer.ts`), so the database scopes every read to the
   signed-in user. This is `mode: 'session'` in the GraphQL context, not the
   service-role `token` mode the `api_token` path uses.
4. **`mobile/` is a sibling project, like `fuse/`.** Its own `package.json`,
   lockfile, TypeScript and React versions, and its own CI job. The web app's
   install, build and deploy are not touched. Expo SDK 57 ships React Native
   0.87 with a React `^19.2` peer and a TypeScript 5.x template; the web app is
   on React 19.3 and TypeScript 7. Coupling the two installs would make every
   dependency bump a two-app change.
5. **No code written twice without a test that says so.** Pure logic the app
   shares with the web app (ISK formatting, icon variation, freshness bands,
   fitting slot order) is imported from `src/` when the toolchain allows
   (phase 0 decides), and otherwise copied **with a test in `test/` that
   asserts the copy matches**.
6. **House rules hold in `mobile/`.** ramda over loops, `ts-pattern` for
   string-literal unions, Node's built-in test runner over pure `.ts` modules,
   oxlint + prettier with the root configs, Simplified Technical English in
   comments and copy. No component test framework: pure logic is tested,
   rendering is checked by the TypeScript build, as in the web app.
7. **The opsec rule from `presentedOwner.ts` holds.** A share that shows the
   account's main must not let the app show the holding character. Until the
   data layer closes that gap (CLAUDE.md, `character_asset_share`), the app
   queries with `includeShared: false` and renders no shared rows.

## Phases

| Phase | Doc | What lands | Depends on |
| ----- | --- | ---------- | ---------- |
| 0 | [00-spike.md](00-spike.md) | `mobile/` scaffold, toolchain proof (Expo 57, pnpm, Metro over `src/`), OAuth 2.1 PKCE sign-in proof against the Supabase auth server, one GraphQL call | nothing |
| 1 | [01-graphql-bearer-jwt.md](01-graphql-bearer-jwt.md) | The server accepts a Supabase JWT as the GraphQL bearer, in session mode; pure `bearerKind` seam, tested | nothing — can start now, in parallel with 0 |
| 2 | [02-app-shell.md](02-app-shell.md) | App shell: tabs, Eve Sans Neue, tokens from `globals.css`, session store, token refresh, sign-out, error and offline states | 0, 1 |
| 3 | [03-characters.md](03-characters.md) | Characters screen at parity with the character cards of `/account/registrations`; the `Character.status` fields added to GraphQL | 2 |
| 4 | [04-assets.md](04-assets.md) | Asset search ("where is my X") and browse-by-place, with type icons | 2 |
| 5 | [05-industry-and-market.md](05-industry-and-market.md) | Industry jobs (ending soon first) and open market orders | 2 |
| 6 | [06-refresh-and-release.md](06-refresh-and-release.md) | The `refresh` mutation (Refresh ESI from the phone), TestFlight through EAS, App Store listing and privacy labels | 3–5 |

Phases 3, 4 and 5 are independent and separately shippable. Phase 1 is a
small server PR with its own test; do not fold it into phase 0.

## Decisions made here, so later phases do not re-open them

- **Expo, managed workflow, Expo Router.** File-based routes under
  `mobile/app/`, which reads like `src/app/`. No bare React Native project.
- **Sign-in is OAuth 2.1 PKCE, never a pasted `api_token`.** The `api_token`
  is a long-lived secret with service-role reads behind it and no sign-out. A
  phone is lost more often than a laptop. The OAuth path gives a short-lived
  access token, a refresh token the server can revoke, and RLS.
- **GraphQL over direct PostgREST.** The pages' data assembly (SCD-2 views,
  name resolution, owner identity, leak guards) lives on the server. The app
  must not re-implement it.
- **No ship fitting stats in v1.** The ship viewer computes stats in a WASM
  dogma engine (`src/app/ship/[itemId]/esf/`). Hermes has no WebAssembly. A
  later phase can add a server endpoint that computes the readout, or a
  WebView of `/ship/[itemId]`. v1 lists a ship's fit without numbers.
- **Dark theme first.** The design system is dark by default. The light
  tokens map onto iOS light mode in phase 2, with no separate design pass.
- **No push notifications in v1.** The ntfy plan (`docs/ntfy-notifications.md`)
  covers alerts without APNs. Native push needs a device-token table and a
  sender in the notification sweep; it is a later project.

## What this plan is deliberately not

- Not an Android plan. Expo would make Android cheap later, but every phase
  here is tested on iOS only. Nothing in it should block Android.
- Not a redesign of the web app, the GraphQL schema's existing fields, the
  sharing layer or the refresh machinery. All reused as is.
- Not a schema change in the database. Phase 3 adds GraphQL fields that read
  tables that already exist. No migrations anywhere in this plan.
- Not a replacement for the MCP server or Links. Those stay the surfaces for
  LLM clients and spreadsheets.

## Owner actions this plan needs

These need the project owner's accounts and cannot be done from a session:

1. **Apple Developer Program** membership (for TestFlight and the App Store),
   and an **Expo (EAS)** account. Phase 6 names where each secret goes.
2. **Register the OAuth client** in the Supabase dashboard (Authentication →
   OAuth Server): a public client named "EDENCOM Link iOS" with the redirect
   URI `edencomlink://auth`. Dynamic client registration is already on for
   MCP; a fixed client gives the consent page a stable name. Phase 0 proves
   the flow with dynamic registration first, so this can wait until phase 2.
3. **A bundle identifier** (`link.edencom.app` is the suggested one) and the
   app name as it appears on the home screen.
