# Open registration: invite codes become referrals, identities affix in any order

## Goal

Registration stops being invite-gated. Instead:

- The moment someone **starts adding a character or signing up**, they get a
  Supabase **anonymous user**. That user id is the account from then on. It is
  minted lazily, at the flow that needs it — reading the site mints nothing.
- An invite code, when present (usually via a shared
  `/account/register?invite=…` link), is **referral attribution** recorded on
  that account — it no longer gates anything.
- The visitor then attaches identities to that same account **in any order**:
  email/password, an EVE Online SSO character, Discord, or GICE. Any one of
  them is sufficient; the others can follow later.
- The sign-up decision logic gets thin, fast unit tests (Supabase mocked)
  running as a GitHub Action, and PRs get forked preview databases via
  Supabase branching (Pro).

## Where we start from (current behavior)

There is **no anonymous user today** — nothing in the codebase calls
`signInAnonymously`. The Supabase user is created at registration time:

- `/account/register` (`register/actions.ts`): requires an unredeemed
  `invite_code`, calls `auth.signUp(email, password)`, then burns the code
  (`redeemed_by = new user id`).
- `/account/gice/complete`: requires an invite code, `admin.createUser` with a
  placeholder email, links `gice_account`, burns the code, `mintSession`.
- `/character/callback`: **requires** an already-authenticated Supabase user;
  EVE SSO only ever *adds characters to* an account, it cannot start one.
- Discord sign-in is designed (`docs/discord-bot/06-discord-sign-in.md`) but
  not implemented; that doc left the invite question open — this plan answers
  it: no invite gate.

`invite_code.redeemed_by` keeps its column but changes meaning: from "the
account this code admitted" to "the account this code referred". The earning
schedule for *minting* codes, Chancellor conferral via `is_chancellor` codes,
and all RLS stay as they are.

## Stage 0 — platform configuration (no code)

- Supabase dashboard: enable **Anonymous sign-ins** and **manual identity
  linking**. (An earlier draft of this plan put a Turnstile captcha in front of
  the anonymous sign-in; Turnstile is deprecated here. Lazy minting plus the
  sweep job is what bounds junk accounts instead.) Enable the **Discord provider**
  (per the stage-06 doc: app id + client secret, Supabase callback URL in the
  Discord portal, scopes `identify email`).
- Install the Supabase **GitHub integration** for branching and the
  **Vercel integration** so preview deployments point at branch databases
  (details in Stage 6).

## Stage 1 — lazy anonymous bootstrap

**PR size:** medium — **landed.** What shipped, where it differed, and what the
RLS audit found is recorded at the end of this section.

- **Lazy anonymous bootstrap:** a server-side `ensureSession()` that calls
  `supabase.auth.signInAnonymously()` when the caller has no session, invoked
  from the Server Actions that begin an identity flow — today the character-add
  action, since `/character/callback` can only attach a character to a session
  that already exists. Not the root layout and not middleware: a page view must
  not mint an account, and a Server Action is where the SSR client's cookie
  writes actually stick.
- **Referral attribution:** with the account minted lazily, there is nothing to
  affix a code to on arrival, so attribution happens where the account is
  created. Sign-up already redeems the code onto the account it mints; the
  later stages carry that forward (and stage 2's in-place conversion is what
  makes the id stable enough for a code to be affixed earlier, should we want
  a shared link to survive an EVE-first sign-up).
- **Migration** (plus the `schema.sql` twin):
  - partial unique index `invite_code (redeemed_by) where redeemed_by is not
    null` — one referral per account, enforced where the race can't cheat it;
  - comment updates recording what the column means.
  `redeemed_by … on delete set null` already returns a code to the pool when
  a never-converted anonymous user is deleted.
- **Anon hygiene:** a nightly `anon-sweep` job (single-step Vercel Workflow
  shape, like the other daily jobs) — abandoning a half-finished flow leaves an
  account behind — deletes `auth.users` rows where
  `is_anonymous` **and** older than ~30 days **and** the account owns nothing:
  no `registration` row, no `gice_account` row, no non-anonymous identity.
  The ownership guard matters because an EVE-SSO-only account stays
  `is_anonymous = true` in Supabase's eyes forever (EVE SSO is not a Supabase
  identity) — see Stage 3.
- **RLS audit (security, do not skip):** Supabase anonymous users carry role
  `authenticated` with an `is_anonymous` JWT claim. Every policy or check
  that means "any signed-in human" now includes accounts still mid-flow. Known hot
  spot: the `public` fitting-share level (`fitting_shared_with_caller()`),
  documented as "any signed-in user" — decide whether that now means truly
  public, or add
  `(select (auth.jwt() ->> 'is_anonymous')::boolean) is not true` to that
  branch. Sweep the other `to authenticated` policies and `withMcpAuth` the
  same way; most extract tables are keyed to the caller's own rows and are
  naturally empty for anon users, so the audit should be short.

### What stage 1 actually landed

- **Minting is lazy, and server-side.** The plan's root-layout client component
  is gone: an account is minted by `ensureSession()`
  (`src/app/account/lib/anonymousSession.ts`) from the character-add Server
  Action, where the SSR client's cookie writes stick, so there is no client
  round trip and no page view mints anything. Until stage 3 puts an EVE
  entry point in front of signed-out visitors, that action is reachable only
  from `/character`, so in practice stage 1 mints for a member who lost their
  cookies mid-flow — the mechanism is what stage 3 plugs into. The captcha is
  gone too (Turnstile is deprecated), which lazy minting makes easier to live
  with: there is no unauthenticated page view that creates a row.
- **The seam the plan only implied:** once any account can hold a session
  before it has an identity, "a user exists" stops meaning "a member is signed
  in", and roughly thirty gates read it that way. `isEstablishedAccount()`
  (`src/app/account/lib/accountStatus.ts`, pure + tested) answers *our*
  question — permanent to Supabase, **or** owns a character — and
  `establishedUser()` next door is the drop-in those gates now call instead of
  `auth.getUser()`. `is_established_account()` in SQL is its twin.
- **No affix-on-arrival.** It presupposed an account existing at page-view
  time, which lazy minting deliberately removes. Both sign-up paths are
  unchanged: they still require an unused code and redeem it onto the account
  they create. The gate comes off in stages 2 and 4.
- `anon-sweep` runs daily at 04:13 UTC over `sweepable_anonymous_users()`,
  ≤500 accounts per run. SQL coverage for the whole migration —
  predicate, policies, index, sweep set — is `test/sql/open_registration.sql`.

### RLS audit findings

Three tables were readable by any authenticated caller (`using (true)`):
`universe_name`, `character_affiliation`, `universe_structure`. All three now
require `is_established_account()`. Everything else was left alone, deliberately:

- per-owner extract tables key on the caller's own registrations, so they are
  naturally empty for an account that owns nothing;
- the fitting/asset/den/link share audiences go through
  `share_audience_matches()`, which needs overlapping corp or alliance
  membership — except its deliberately public branch (no secret, no audience
  lists), which the sharing-layer docs define as *public*, so anonymous callers
  reading it is the intended semantic, not a leak. (The plan flagged the
  level-era `public` share as the hot spot; Revision 3 had already made the
  answer explicit.);
- world-readable tables were already granted to the `anon` role, so anonymous
  sign-ins change nothing about them;
- write policies pin `created_by`/`user_id` to `auth.uid()`, and
  `mercenary_den_enemy_intel` additionally requires owning a registration —
  which is the established test by another name.

The MCP surface needs nothing: `withMcpAuth` hands every tool an RLS-scoped
bearer client, so an anonymous caller's tools return their own (empty) data.

## Stage 2 — email/password from the anonymous session

**PR size:** small

- `register/actions.ts`: replace `auth.signUp` with
  `auth.updateUser({ email, password })` on the current (anonymous) session —
  this is Supabase's documented anonymous→permanent conversion, the user id
  is stable, so anything already affixed (referral, characters) carries over.
  Confirmation email flows through the existing `/account/confirm` route.
  Keep `auth.signUp` as the fallback when no session exists (JS disabled, so
  the bootstrap never ran). Keep the throttle delay.
- `registerForm.tsx`:
  - Invite field **hidden by default**; drop the "invite-only" copy.
  - If the anonymous user already has an affixed code, quietly show
    "Referred by *\<inviter's main character\>*" — resolved server-side
    (service role: `invite_code where redeemed_by = uid` → `created_by` →
    the existing `mainCharacterNameForUser`). Founding/seed codes
    (`created_by` null) show nothing.
  - Otherwise render a small, subtle link **"No Invite Code Required"**;
    clicking it reveals the invite input, which keeps today's debounced
    `lookupInvite` "Invited by …" feedback, and submitting affixes the code
    alongside the conversion.

## Stage 3 — EVE SSO as a first (and sufficient) identity

**PR size:** medium

`/character/callback` already works once a session exists — the anonymous
session satisfies its auth check, so "add a character before registering"
mostly falls out of Stage 1. What's left:

- **Sign-in / duplicate handling:** when the callback's `(character_id,
  owner)` is already registered to a *different* user and the current caller
  is a fresh anonymous user (no identities, no registrations), don't create a
  second account holding the same character — `mintSession` into the existing
  owner instead. This is simultaneously the returning-user "Log in with EVE
  Online" path and the recovery path for an EVE-only account whose browser
  cookies were lost. A non-anonymous caller keeps today's behavior (the
  upsert is keyed `(user_id, owner)`).
- Add a "Log in with EVE Online" button on `/account/login` pointing at the
  existing SSO start route.
- **Nudge to durability:** an account whose only identity is EVE SSO lives on
  a Supabase anonymous user (see Stage 1's sweep guard). Show a quiet header
  banner on such accounts — "add an email, Discord, or GICE so you can sign
  in from anywhere" — since the character token is their only key.

## Stage 4 — GICE without the gate

**PR size:** small

- `/account/gice/complete/actions.ts`: with a live (anonymous) session, stop
  calling `admin.createUser`. Instead link `gice_account` to `auth.uid()` and
  `admin.updateUserById(uid, { email: giceEmail(...), email_confirm: true })`
  to convert the anonymous user in place; no `mintSession` needed (they're
  already signed in). If the `gice_id` is already linked to another account,
  keep today's behavior: `mintSession` into the winner.
- The complete page's invite field gets the same optional treatment as
  Stage 2 (referred-by line, or the subtle reveal link).

## Stage 5 — Discord

**PR size:** medium (mostly the stage-06 doc, now unblocked)

Implement `docs/discord-bot/06-discord-sign-in.md` with the invite question
resolved as **no gate**:

- Anonymous session present (the normal case):
  `auth.linkIdentity({ provider: 'discord' })` — natively converts the
  anonymous user. Returning users: `signInWithOAuth` from login/register.
- PKCE callback route per the `@supabase/ssr` cookie pattern; "Connected
  accounts" link/unlink section on `/account/settings` (Supabase refuses to
  unlink the last identity, so nothing strands).

After stages 2–5, "do the others later" needs no extra work: email via the
existing `/account/email`, characters via `/character`, Discord via settings,
GICE via `/account/gice` — all keyed on the stable `auth.uid()`.

## Stage 6 — tests, CI, Supabase branching

**PR size:** small–medium

- **Pure seams first.** The actions stay thin wrappers; the decisions move to
  a pure module (suggested `src/app/account/lib/signupFlow.ts`) taking narrow
  injected interfaces instead of real clients:
  - `affixInvite(db, { code, userId })` — pattern check, unredeemed check,
    already-referred no-op, race-guarded write;
  - `resolveReferrer(db, userId)` — redeemed code → creator → main-character
    name, seed-code and no-code branches;
  - `emailConversionPlan(sessionUser)` — `updateUser` vs `signUp` fallback;
  - `characterCallbackPlan({ caller, existingOwner })` →
    `'attach' | 'sign-in-existing'`;
  - `giceCompletionPlan({ sessionUser, existingLink })` →
    `'link-in-place' | 'sign-in-existing' | 'create'` (the no-session
    fallback).
- **Tests:** `test/signupFlow.test.ts` in the house style — `node --test`,
  no framework, hand-rolled stub objects standing in for the Supabase
  clients (the existing `test/*.test.ts` files are the template). Thin and
  fast: no network, no DB.
- **CI:** new `.github/workflows/test.yml` on pull requests and pushes to
  `main` — pnpm install, `pnpm test`, `pnpm run lint`. (Extract jobs left
  Actions for scheduling reliability; PR-triggered CI doesn't have that
  problem.)
- **Supabase branching (Pro):** install the Supabase GitHub integration so
  each PR gets a forked preview database with `supabase/migrations/**`
  applied automatically, and the Supabase↔Vercel integration so preview
  deployments receive that branch's credentials. Division of labor:
  - unit tests mock Supabase and never touch a database;
  - branching validates the *migrations* and gives preview deploys a real,
    isolated database (this project's Stage 1 migration is the first
    customer);
  - production stays with the existing `migrate.yml` on push to `main` —
    keep branching in "preview only" mode so the two appliers never fight.

## Explicitly unchanged

- Invite-code **minting** and its earning schedule (`/account/invite`),
  Chancellor conferral through `is_chancellor` codes, and the invite pages'
  RLS ("users read own codes").
- `registration` / `token` write paths (`/character/callback` remains the
  sole, service-role, SSO-verified writer).
- No new tables; one migration (partial unique index + comments).

## Risks / open edges

- **Anon-user volume:** bounded first by lazy minting — no page view creates an
  account — then by the sweep job. The captcha is gone (Turnstile deprecated),
  so Supabase's own rate limits are what stand in front of a bot that drives
  the sign-up flow itself. Watch `auth.users` growth after launch; if it runs
  away, the answers are a shorter sweep cutoff or a captcha that isn't
  Turnstile.
- **Two tabs, two anonymous users:** two flows started at once can mint
  separately; harmless (one converts, the other gets swept), but worth knowing
  when reading auth logs.
- **`is_anonymous` semantics drift:** EVE-only accounts are permanent to us
  but anonymous to Supabase. Every "is this a real account?" check must ask
  *our* question (has identity or registration), not Supabase's flag — the
  sweep guard and the Stage 3 banner both encode this.
- **Referral display privacy:** the register page reveals the inviter's main
  character name to whoever holds the link — same exposure as today's
  `lookupInvite`, now just automatic.
