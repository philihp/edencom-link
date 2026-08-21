# Stage 06 — Discord as an auth method

**Status: implemented** (stage 5 of docs/open-registration.md), behind the
`DISCORD_AUTH` env gate until the Supabase provider is configured — the
dashboard steps are listed at the end of that stage. What follows is the design
this was built from; where the implementation differs, the open-registration doc
records why.

**PR size:** medium · **Depends on:** 02 (the Discord application exists) ·
**Independent of:** 03–05 (no bot, no channels, no outbox involved)

## Goal

- A new user can create an edencom.link account by authenticating with
  Discord alone — no email/password step.
- A Discord-only user can add email/password later.
- An existing email/password user can add Discord to their account.

## Design: Supabase Auth's native Discord provider

No hand-rolled OAuth client. Supabase Auth ships a Discord provider; the
whole feature is dashboard configuration plus a handful of client calls:

- **Sign in / sign up:** `supabase.auth.signInWithOAuth({ provider:
'discord', options: { redirectTo } })` from a "Continue with Discord"
  button on `/account/login` and `/account/register`. Supabase creates the
  account on first sign-in (identity in `auth.identities`, carrying the
  Discord user id, username, avatar).
- **Add Discord to an email account:** `supabase.auth.linkIdentity({
provider: 'discord' })` from a new "Connected accounts" section on
  `/account/settings`. Requires **manual linking** enabled in the Supabase
  dashboard (Authentication → Providers). `unlinkIdentity` for removal —
  Supabase refuses to unlink the last identity, so a Discord-only account
  can't strand itself.
- **Add email/password to a Discord-only account:**
  `supabase.auth.updateUser({ email, password })` from settings; email
  change confirms via the existing `/account/confirm` OTP route.

## Platform configuration (not code)

- Supabase dashboard: enable the Discord provider with the same
  `DISCORD_APP_ID` + a client secret (new env var `DISCORD_CLIENT_SECRET`
  for local parity, though Supabase holds the live value); enable manual
  linking.
- Discord developer portal: add Supabase's callback
  (`https://<project-ref>.supabase.co/auth/v1/callback`) as an OAuth2
  redirect. Scopes: `identify email` only.
- An auth-code callback route (`/account/callback` or reuse of the PKCE
  flow in `@supabase/ssr`) exchanges the code for a session — follow the
  current `@supabase/ssr` cookie pattern used by `src/utils/supabase/*`.

## Interactions with the rest of the app

- **Invite gating: resolved as no gate.** Registration stopped being
  invite-gated (docs/open-registration.md); a code is referral attribution
  wherever one is offered, so Discord bypasses nothing. There is no post-OAuth
  landing step, and none is wanted: the fewer steps between the consent screen
  and a working account, the better.
- **Stage 03 linking:** an account's Discord identity (in
  `auth.identities`) lets the `/edencom link` handler bind a channel by
  matching the invoking Discord user id — no link code. See the amended
  design note in 03-account-linking.md.
- `user_settings` and everything else keys off `auth.uid()` and is
  unaffected by which identity signed in.

## Milestone / acceptance

- Fresh browser: "Continue with Discord" creates a working account
  (assets/settings pages behave exactly like an email account's).
- That account adds an email/password and can then sign in with either.
- An existing email account links Discord in settings, signs out, and signs
  back in via Discord to the same account (same `user_id`).
- Unlinking the sole identity is refused with a clear message.
- `pnpm run lint` + `pnpm run build` pass.

## Out of scope

- Storing Discord tokens ourselves (Supabase holds the provider tokens; we
  only ever need the Discord user id from the identity).
- Using the Discord identity for bot features (stage 03 consumes it).
- Discord avatar/username display in the header (cheap follow-up).
