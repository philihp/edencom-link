# Phase 2 — App shell: navigation, theme, session, errors

## Goal

The frame every later screen sits in. After this phase the app has tabs, the
brand type and colours, a persistent session that refreshes itself, a sign-out,
and one way to show "loading", "offline", "signed out" and "the server said
no". Screens added in phases 3–5 are then only data and layout.

## Files

- `mobile/app/_layout.tsx` — root layout: loads fonts, provides the session
  and the GraphQL client, redirects to `/sign-in` when there is no session.
- `mobile/app/(tabs)/_layout.tsx` — the tab bar: `characters`, `assets`,
  `industry`, `market`, `account`. Lowercase labels, as the web nav.
- `mobile/app/sign-in.tsx` — one button: "Sign in with EDENCOM Link". Opens the
  phase-0 PKCE flow. Below it, the same one-paragraph explanation the consent
  page shows: what the app will read.
- `mobile/app/(tabs)/account.tsx` — who is signed in (`characters { name }`
  from the context), the deployment origin, "Sign out", the app version, a
  link to `/account/settings` on the website for everything the app does not
  do (adding a character, grants, sharing).
- `mobile/src/theme/tokens.ts` — the colour tokens from `src/app/globals.css`
  (`--paper`, `--ink`, `--accent`, `--ok/--warn/--danger/--info`, the radii),
  both schemes, as a typed object keyed by `useColorScheme()`. Copy the values;
  add a test in `mobile/test/tokens.test.ts` that reads `globals.css` from the
  repo and asserts each dark value matches, so the two cannot drift.
- `mobile/src/theme/fonts.ts` — `expo-font` loading the eight OTFs from
  `public/fonts/` (copied into `mobile/assets/fonts/` at build time by a small
  script in `mobile/package.json`, so the web app stays the source).
  `--sans` → Eve Sans Neue, headings → Eve Sans Neue Expanded, numbers → the
  system monospace, as `globals.css` does.
- `mobile/src/api/client.ts` — the GraphQL client: a thin `fetch` wrapper that
  attaches the bearer, refreshes once on 401 and retries once, maps GraphQL
  `errors` to a typed `ApiError`, and exposes `useQuery(document, variables)`
  built on React's `use()` or a small cache. **No Apollo, no urql**: the schema
  is small, the queries are few, and the house prefers plain code.
- `mobile/src/api/documents.ts` — every query document the app uses, as
  strings, next to a `node --test` that parses each with `graphql`'s `parse`
  and validates it against `src/app/api/graphql/schema.graphql.ts` (imported
  through the phase-0 sharing decision, or read as a file). A screen cannot
  ship a query the server would reject.
- `mobile/src/ui/` — `Screen` (safe area, scroll, pull to refresh),
  `Row`, `Badge`, `StatusDot`, `Freshness` (green under 15 min, yellow under
  75, red after — the bands from `src/app/freshness.ts`), `Isk` (the
  formatting from `src/app/isk.ts`), `EmptyState`, `ErrorState`.

## Steps

1. Theme and fonts first; a screen with the wordmark and a sample of each
   token, kept as `mobile/app/dev/theme.tsx` behind `__DEV__`.
2. Session: move the spike's `session.ts` to `mobile/src/auth/`, add
   `signOut()` (clear the secure store; call the server's revocation endpoint if
   the discovery document names one), and the proactive refresh (refresh when
   under two minutes remain, on app foreground via `AppState`).
3. The GraphQL client and the documents test.
4. Tabs with placeholder screens, each using `Screen` and `useQuery` against a
   trivial document, so the plumbing is exercised before any real screen.
5. States: airplane mode shows `ErrorState` with "Offline" and a retry; an
   expired refresh token sends the user to `/sign-in` with a one-line reason.

## Done when

- A fresh install signs in, kills the app, reopens it, and is still signed in
  with no network call before the first screen paints.
- Sign out returns to `/sign-in`; reopening stays signed out.
- The tokens test and the documents test pass under `node --test`.
- Light and dark system schemes both render with the right token set.
- `tsc --noEmit` passes in `mobile/`; the `mobile` CI job is green.

## Risks and notes

- **Fonts in a build.** `expo-font` loads at runtime; for a store build,
  `expo-font`'s config plugin embeds them. Use the plugin from the start so
  TestFlight and the simulator behave the same.
- **No browser client, by design.** The web app has no `createBrowserClient`
  because its cookies are httpOnly. The mobile app is not a browser; it holds
  a bearer token and talks only to `/api/graphql`. It never imports
  `@supabase/supabase-js`.
- **Clock skew.** Use `exp` from the token minus a margin; do not trust the
  phone's clock alone for "is this expired". A 401 with retry covers the rest.
