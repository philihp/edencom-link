# GICE (Goonfleet SSO) as an auth method

A new user can create an edencom.link account by authenticating with GICE
(gice.goonfleet.com, The Imperium's OpenID Connect identity provider) — no
email/password step. A GICE-only account can add a real email (and password)
later at `/account/email`, and an existing email account can link GICE from
settings. The same `/account/email` page serves Discord-only accounts once
Discord sign-in (docs/discord-bot/06-discord-sign-in.md) lands.

## Why hand-rolled OIDC (unlike Discord)

Supabase Auth ships a native Discord provider but has no way to add an
arbitrary OIDC issuer, so GICE is implemented as a small authorization-code
client of our own:

- `/account/gice` (route handler) starts the flow: reads GICE's discovery
  document (`https://gice.goonfleet.com/.well-known/openid-configuration`,
  cached 6h per process — the issuer actually lives on esi.goonfleet.com),
  sets a `state:verifier` cookie (CSRF + PKCE S256), and redirects to the
  authorization endpoint with `scope=openid` (which already carries the
  `sub`/`name`/`pri_grp` claims we read).
- `/account/gice/callback` exchanges the code (client_secret_basic +
  code_verifier) and reads `/oauth/userinfo` with the access token — claims
  are trusted from userinfo rather than by validating the id_token's
  signature, since the access token came straight from the token endpoint
  over TLS. Then, by who arrived:
  - **signed-in user** → link: insert a `gice_account` row for them (or
    bounce to settings with `?gice=conflict` if that GICE account belongs to
    someone else), back to `/account/settings`.
  - **signed-out, GICE id already in `gice_account`** → sign-in: refresh the
    display fields and mint a session.
  - **signed-out stranger** → registration: stash the verified identity in a
    signed 10-minute `gice_pending` cookie (HMAC keyed off
    `SUPABASE_SERVICE_KEY`) and continue to `/account/gice/complete`.
- `/account/gice/complete` keeps registration invite-only: the pending cookie
  proves who they are, an unused invite code (same `invite_code` machinery
  and live inviter lookup as the email register form) proves they were asked
  in. The action creates the Supabase user with a **placeholder email**
  `gice-<id>@sso.edencom.link` (`email_confirm: true`; the domain never
  receives mail), inserts the `gice_account` row, burns the code, and signs
  them in.

## Session minting without a password

`mintSession(userId)` (`src/app/account/lib/mintSession.ts`): the service
role calls `auth.admin.generateLink({ type: 'magiclink' })` for the user's
email — generateLink only creates the token, it never sends mail, so
placeholder addresses are fine — and the cookie client immediately consumes
the `hashed_token` via `verifyOtp`. This is the standard self-serve pattern
for custom OAuth providers on Supabase.

## Adding a real email later

`/account/email` (linked from the settings "Sign-in methods" section, which
flags placeholder addresses as "none yet") calls
`supabase.auth.updateUser({ email, password? })`. Supabase emails the new
address a confirmation link that lands on the existing `/account/confirm`
OTP route; the optional password fields also unlock plain email/password
login.

**Dashboard requirement:** Authentication → Email → "Secure email change"
must be **off** (confirm on the new address only). With double-confirm on,
the change would also wait on a confirmation sent to the undeliverable
placeholder address and never complete.

## Platform configuration

- Register an OIDC application while signed in at https://gice.goonfleet.com/
  (POST `/Api/Oauth/Application` with a temporary token from
  `/Api/Account/Token`; the clientSecret is shown only once). List both the
  local and production callback URLs in `redirectUris`.
- Env vars (`.env.example`): `GICE_CLIENT_ID`, `GICE_SECRET_KEY`,
  `GICE_CALLBACK_URL` (e.g. `https://edencom.link/account/gice/callback`).
  The start route answers 503 when unset, so deployments without GICE
  configured degrade gracefully.

## Schema

`gice_account` (migration `20260805010000_gice_account.sql`): `gice_id`
(bigint PK, the OIDC `sub` — the forum account id) ↔ `user_id` (unique FK →
auth.users, cascade), plus display-only `name` / `primary_group` refreshed on
each sign-in. RLS: owners select their own row; all writes go through the
service role from the callback/complete server code.
