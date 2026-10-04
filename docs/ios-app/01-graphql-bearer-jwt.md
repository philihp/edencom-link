# Phase 1 — GraphQL accepts a Supabase JWT as its bearer

## Goal

`POST /api/graphql` with `Authorization: Bearer <supabase access token>` runs
the query as that user, under RLS, in `mode: 'session'`. Today every bearer is
read as an `api_token` and resolved through the service role
(`src/app/api/graphql/context.ts`, `buildContext`). This phase adds a second
bearer kind without changing the first.

This is a server-only PR. It needs nothing from phase 0 and unblocks phases
2–6. It also gives any future client that holds a Supabase session (a CLI, a
browser extension, Claude through the MCP OAuth flow) the GraphQL endpoint for
free.

## Files

- `src/app/api/graphql/bearerKind.ts` — new, pure, no I/O.
  `bearerKind(token: string): 'jwt' | 'api_token'`. A Supabase access token is
  a compact JWS: exactly three dot-separated base64url segments, the first of
  which decodes to JSON with `alg`. An `api_token` is an opaque string with no
  dots. Decide on shape only — never on length, never by trying one lookup and
  then the other (a failed `api_token` lookup must stay a 401, not a fallback).
- `src/app/api/graphql/context.ts` — `buildContext`: when `bearerKind(bearer)`
  is `'jwt'`, build `createBearerClient(bearer)`
  (`src/utils/supabase/bearer.ts`), call `supabase.auth.getClaims(bearer)` as
  `src/app/api/mcp/auth.ts` does, deny with 401 on error or missing `sub`,
  then `contextFor(supabase, 'session', claims.sub)`. The `api_token` branch
  and the cookie branch do not change.
- `test/graphqlBearerKind.test.ts` — the pure seam: a real-looking ES256 JWT
  → `'jwt'`; a 32-hex `api_token` → `'api_token'`; a string with two dots but
  a non-JSON first segment → `'api_token'` (it will then fail the lookup as it
  does today); the empty string is never passed (callers check first).
- `src/app/api/graphql/route.ts` — comment only: the auth line now names three
  modes.
- `CLAUDE.md` — the MCP/GraphQL notes: "GraphQL bearer is an `api_token`
  (service role, own data) **or a Supabase JWT (RLS, session mode)**".

## Steps

1. Write `bearerKind` and its test first. Run `pnpm test`.
2. Change `buildContext`. Keep the deny messages: the 401 text for a missing
   bearer still says "Send Authorization: Bearer <api_token>, or sign in", and
   a JWT that fails verification says "Bearer token is not valid or has
   expired." — a different message, so a client can tell the two apart.
3. Check the two places that build a context outside a request
   (`contextForUser`, the Link runner) are untouched. They are.
4. Prove it against a preview deployment with a real token: sign in on the
   website, copy the access token from the Supabase session (or from the
   phase-0 app), and `curl -H "Authorization: Bearer $JWT" -d '{"query":"{
   characters { name } }"}' …/api/graphql`. Then the same call with a stale
   token: expect 401. Then with the `api_token`: expect the same rows as
   before. Paste the three outcomes in the PR.

## Done when

- The three curl outcomes above hold.
- `includeShared: true` works for a JWT bearer (session mode) and is still
  refused for an `api_token` bearer (token mode) — the same rule as the cookie
  session versus Sheets today.
- `pnpm test`, `pnpm run lint`, `pnpm run build` pass.

## Risks and notes

- **Server-Timing**: the bearer client's `fetch` is already
  `timedSupabaseFetch('db')`, so the spans arrive as they do for the cookie
  client. Nothing to add.
- **Anonymous accounts.** A Supabase JWT can belong to an anonymous user mid
  sign-up (`docs/open-registration.md`). `contextFor` reads the caller's
  registrations under RLS; an anonymous user with none gets empty lists, which
  is correct. Do not add an `establishedUser()` gate here: the web page's gate
  is about rendering a member page, and GraphQL answering "no characters" is
  the honest answer.
- **Rate of `getClaims`.** It verifies locally against the project's JWKS
  (cached per process). It is not a round trip to the Auth server on each
  request. See the note in `src/app/account/lib/establishedUser.ts`.
- **The OAuth token's `aud`/`scope`.** Supabase's OAuth server issues JWTs that
  PostgREST accepts (the MCP tools already prove this). If the token carries a
  `client_id` claim, `mode` could later distinguish OAuth clients from cookie
  sessions for logging; not needed now.
