# Phase 0 — Spike: the toolchain and the sign-in, proven end to end

## Goal

One screen that signs the pilot in through the website and lists their
characters from GraphQL. Nothing else. The spike exists to answer the three
questions the later phases depend on, with evidence rather than belief:

1. Does Expo SDK 57 under pnpm build and run from `mobile/` without touching
   the web app's install?
2. Does Supabase Auth's OAuth 2.1 server issue a usable access token **and a
   refresh token** to a public PKCE client, and does the refresh grant work?
3. Can Metro import a pure module from `../src/` (for example
   `src/app/isk.ts`), or must shared logic be copied?

A spike that answers "no" to any of these is a success: it changes the plan
before the plan costs anything.

## Files

- `mobile/` — new. `npx create-expo-app@latest mobile --template blank-typescript`,
  then Expo Router added per its install guide. Own `package.json` with
  `"packageManager": "pnpm@11.27.1"` (matching the root), own `pnpm-lock.yaml`.
  **Do not** add `mobile` to the root `pnpm-workspace.yaml` `packages:` list.
  Vercel installs the root with pnpm 9; a second member would change what it
  hoists and could reach `next` or `workflow`.
- `mobile/.npmrc` — `node-linker=hoisted`. Metro resolves symlinked
  `node_modules` badly; hoisting under `mobile/` alone is the known Expo + pnpm
  fix, and it affects nothing outside `mobile/`.
- `mobile/metro.config.js` — the default Expo config, plus (for question 3)
  `watchFolders: [path.resolve(__dirname, '..', 'src')]` and
  `resolver.nodeModulesPaths` including `mobile/node_modules`.
- `mobile/tsconfig.json` — extends `expo/tsconfig.base`; `paths` maps
  `@web/*` → `../src/*` **only if question 3 passes**.
- `mobile/app/_layout.tsx`, `mobile/app/index.tsx`, `mobile/app/auth.tsx`
  (the redirect route the auth sheet returns to).
- `mobile/src/auth/oauth.ts` — the PKCE flow: `expo-auth-session` against the
  discovery document at
  `${SUPABASE_URL}/.well-known/oauth-authorization-server/auth/v1` (the RFC 8414
  metadata the MCP protected-resource route already points at), redirect
  `edencomlink://auth`, scopes as the server advertises.
- `mobile/src/auth/session.ts` — stores `{ accessToken, refreshToken, expiresAt }`
  in `expo-secure-store`; `refresh()` runs the `refresh_token` grant.
- `mobile/src/api/graphql.ts` — one `fetch` to `${API_ORIGIN}/api/graphql`
  with `Authorization: Bearer <accessToken>`; the query is
  `{ characters { id name characterId corporationName } }`.
- `mobile/app.json` — `scheme: "edencomlink"`, `ios.bundleIdentifier`,
  `extra.apiOrigin` and `extra.supabaseUrl` (public values; the anon key is
  **not** needed, since the app never calls Supabase's REST API itself).
- `.github/workflows/test.yml` — a `mobile` job (see CI below).
- `CLAUDE.md` — one bullet under Layout for `mobile/`, like the `fuse/` one,
  and a pointer to this plan. Written when the directory exists, not before.

## Steps

1. Scaffold `mobile/`, pin pnpm, set `node-linker=hoisted`, run
   `pnpm install` and `npx expo start --ios` on a simulator. Commit when the
   blank app runs. This is the answer to question 1.
2. Add the OAuth flow. Until the owner registers a fixed client, use dynamic
   client registration (`POST ${SUPABASE_URL}/auth/v1/oauth/clients/register`
   or whatever the discovery document names under `registration_endpoint`),
   the same way an MCP client does. Record the client id in the session store.
3. Sign in on the simulator. The system sheet opens the website's login, then
   `/oauth/consent`, then returns to `edencomlink://auth?code=…`. Exchange the
   code. **Write down** the token response shape in this document's Findings
   section: is `refresh_token` present, what is `expires_in`, what `scope`
   came back.
4. Run the refresh grant once by hand and record whether it works. If it does
   not, the plan's auth constraint changes: phase 2 would instead re-run the
   PKCE flow silently when the access token expires (the auth sheet skips the
   consent screen for an already-consented client, per
   `src/app/oauth/consent/page.tsx`), and this document says so.
5. Call GraphQL with the access token. **Until phase 1 lands this returns
   `401 Invalid api token`**, because `buildContext` reads every bearer as an
   `api_token`. That 401 is the expected result of the spike on its own; run
   the spike against a phase-1 preview deployment to see characters listed.
   Record both outcomes.
6. Question 3: import `formatIsk` from `@web/app/isk` (or whichever pure
   module is smallest) into the index screen. If Metro resolves it and the
   module's own imports (`ramda`) resolve from `mobile/node_modules`, sharing
   works. If not, try `watchFolders` with the repo root and
   `nodeModulesPaths` with the root `node_modules`. Record what worked. If
   nothing does within a bounded effort (one session), the answer is "copy
   with a matching test", and phases 2–5 follow that.
7. CI: add a `mobile` job to `test.yml` that runs `pnpm install
   --frozen-lockfile`, `pnpm exec tsc --noEmit` and `node --test
   "test/**/*.test.ts"` in `working-directory: mobile`. No binary build, no
   simulator. Lint: run the **root** oxlint over `mobile/` by adding
   `mobile/**` to nothing — oxlint already walks the whole repo; only
   `mobile/node_modules/**` and `mobile/.expo/**` need adding to
   `.oxlintrc.json`'s `ignorePatterns`. Prettier: add `mobile/` to the root
   `pretty` script's path list.

## Done when

- The blank Expo app runs on an iOS simulator from a fresh clone with
  `cd mobile && pnpm install && npx expo start --ios`.
- Sign-in through the website works, and the token response is recorded below.
- The three questions each have a written answer in Findings.
- The `mobile` CI job is green on the PR.
- The root `pnpm install`, `pnpm run build`, `pnpm test` and `pnpm run lint`
  are unchanged in behaviour (the web app's lockfile has no diff).

## Risks

- **Dynamic client registration may be off or restricted** for public
  clients. Then step 2 needs the owner to register the client first (README,
  owner action 2). Ask; do not work around it.
- **The consent page redirects to `/account/login?next=…` when signed out.**
  That is the intended path. Make sure the auth sheet is allowed to follow it
  (`expo-web-browser` `openAuthSessionAsync` follows redirects until the
  custom scheme).
- **`expo-auth-session` discovery** expects `authorization_endpoint`,
  `token_endpoint` and optionally `registration_endpoint`. If Supabase's
  metadata nests them differently, read the document once and pass the
  endpoints explicitly.
- **TypeScript 7 at the root** is not used by `mobile/`; Expo's template pins
  5.x. Keep it that way. Nothing in `mobile/` is type-checked by the root
  `next build`.

## Findings

_Filled in by the session that runs the spike. Keep it short and factual._

- Question 1 (toolchain):
- Question 2 (tokens): token response shape, `expires_in`, refresh grant result:
- Question 3 (sharing `src/` modules): what Metro resolved, final decision:
- Anything that changes a later phase:
