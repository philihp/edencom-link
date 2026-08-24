# Plan: corp-owned BPO showcases (`/bpos/[name]` for a corporation)

## Problem

A player reports the showcase is empty for them because they keep their
blueprint originals in a corp hangar. Anything deposited
into a corp hangar becomes a **corporation** asset, so those BPOs land in
`corp_blueprint` (via the daily `corp-blueprints` job) and never in
`character_blueprint` — the showcase at `/bpos/[name]`, which reads only
`character_blueprint` across the account's registrations, shows nothing.

Extend the showcase so the URL segment can also name a **corporation**:
`/bpos/some-mining-corp` lists that corp's blueprint originals, with the same
private-by-default sharing model the account page has.

## What already exists (nothing new to ingest)

- `corp_blueprint_over_time` + `corp_blueprint` view already carry exactly the
  columns the showcase needs (`type_id`, `material_efficiency`,
  `time_efficiency`, `quantity`, `runs`), populated daily by `corp-blueprints`
  from a Director-scoped token (`esi-corporations.read_blueprints.v1`).
- RLS on it already answers "is the viewer in this corp": members read rows for
  corps their registrations belong to.
- `corporation` (world-readable, `corporation_id`, `name`, `alliance_id`) gives
  us name → id resolution for the URL.
- The pure seams are subject-agnostic already: `stack.ts` (original test,
  stacking, sort orders) and `slug.ts` both operate on names and rows, not on
  accounts.

## Design

### 1. URL namespace: one route, corporation first

Keep the single `/bpos/[name]` route. Resolution order:

1. A corporation whose **name** slugifies to this (`corporation.name` probed
   with the same `slugLikePattern` `_`-wildcard trick, then narrowed by exact
   `characterSlug()` comparison — corp names allow the same space/dash
   ambiguity). Corp-first because there are far fewer corporations than
   registrations: the common case settles on one cheap probe of a small,
   world-readable table.
2. Only if no corporation matches: `resolveBposAccount(slug, viewer)` — an
   account whose **main** character slugifies to this (existing behavior,
   unchanged).
3. Two corporations slugifying identically (shouldn't happen — EVE corp names
   are unique — but the slug folds case and whitespace): resolve to nothing,
   same coin-flip refusal as ambiguous accounts.

A character-vs-corp name collision therefore hides the character's page behind
the corp's. Accepted: EVE disallows a corp taking an in-use character name, so
real collisions are near-impossible. No `/bpos/corp/[name]` sub-route — one
namespace, one URL shape to share.

Refactor `access.ts` around a discriminated subject:

```ts
type BposSubject =
  | { kind: 'account'; userId: string; registrations: BposRegistration[]; mainName: string }
  | { kind: 'corporation'; corporationId: number; name: string }
```

`resolveBposSubject(slug, viewer)` tries corporation then account.
`ts-pattern` `.exhaustive()` on `kind` where the page branches.

### 2. New table: `corp_bpo_share`

`bpo_share` is `user_id`-keyed ("everything this account owns"); the corp
subject needs its own row. New table on the Revision 3 audience shape:

```sql
create table public.corp_bpo_share (
  id uuid primary key default gen_random_uuid(),
  corporation_id bigint not null unique,
  corporation_ids bigint[] not null default '{}',
  alliance_ids bigint[] not null default '{}',
  secret text,
  created_by uuid references auth.users(id) on delete set null,  -- audit only
  created_at timestamptz not null default now()
);
```

- One row per corporation (`unique`), exactly like `bpo_share`'s one row per
  account. No row → page 404s for outsiders → a guessed corp name confirms
  nothing.
- **Manage policy:** any authenticated user with a registration in the corp
  (`corporation_id in (select corporation_id from registration where user_id =
  auth.uid())`). Rationale: that is precisely the set who can already read
  `corp_blueprint` for the corp, so no one can share data they can't see.
  - *Flagged decision:* this lets any member (not just Directors) publish the
    corp's library. We don't track in-game roles; the alternative — restrict to
    accounts holding a `esi-corporations.read_blueprints.v1` token — only
    proves the scope was granted, not the Director role, and blocks the common
    "alt holds the token, main manages the page" case. Recommend member-manage,
    called out in the share dialog hint ("any member of the corp can change or
    revoke this share").
- **Audience read policy:** the standard load-bearing Revision 3 policy,
  `using (public.share_audience_matches(corporation_ids, alliance_ids, secret))`
  to `anon, authenticated` — identical to `bpo_share`'s. Fully-public rows are
  still settled app-side through the service role (same reasoning as the
  account page: no anon evaluation of `my_corporation_ids()`).

Migration hygiene (per the hard-won rules): edit `schema.sql` **and** add one
incremental migration scaffolded by `pnpm run db:new corp_bpo_share` — fresh
clock timestamp, never copied, never renamed. The last `bpo_share` migration was
lost to exactly this (docs/bpo-share-collision.md).

### 3. Access rules (`bposAccess` for the corp subject)

Mirror of the account ladder, with "member" replacing "owner":

1. **`member`** — the viewer has a registration in the corp (service-role check
   against `registration.corporation_id`, or equivalently a viewer-client probe
   of `corp_blueprint`). Members always see the page; that's where the share
   dialog lives.
2. No `corp_bpo_share` row → `null` → 404.
3. **`public`** — the row names no one (`secret is null`, both arrays empty).
4. **`link`** — `?share=` verified by the existing `verifyShareToken` over the
   row's `id`/`secret` (`src/shareToken.ts`, unchanged — it signs share ids,
   not subjects).
5. **`audience`** — viewer-client `select` on `corp_bpo_share` filtered to the
   corp; the audience policy answers via `share_audience_matches`, so
   membership math stays in Postgres.

### 4. Data read

New `fetchCorpBpoEntries(corporationId)` in `data.ts`: service-role,
`corp_blueprint`, `.eq('corporation_id', ...)`, `.eq('runs', -1)`, range-paged
at 1000 exactly like `readBlueprints`. Extract the SDE-dressing tail of
`fetchBpoEntries` (stack → blueprint names → product categories) into a shared
`dressStacks(rows)` both fetchers call — the row shape is identical, so
`stackBpos` and `BpoEntry` are reused untouched.

Note the corp mirror is **daily** (vs 6h for characters); worth a `Freshness`-
style caveat only if someone asks — the showcase has no freshness UI today, so
none added.

### 5. Page and share dialog

`[name]/page.tsx` branches on `subject.kind`:

- Title: `The Blueprint Library of <corp name>` (serif h1, unchanged styles,
  same count/subtitle/table/empty-state).
- `generateMetadata` stays URL-derived (never confirms existence).
- Share dialog renders for `access === 'owner' || access === 'member'`. New
  `saveCorpBposShare(slug, corporationId, input)` / `revokeCorpBposShare` server
  actions mirroring `shareActions.ts`: verify the caller has a registration in
  the corp (the RLS manage policy enforces it too, but fail with a message
  first), filter requested audience ids against the caller's own
  corps/alliances via the existing `ownAudiences` helper, upsert
  `onConflict: 'corporation_id'`. `fetchCorpBposShareDialogData` reads the row
  through the **cookie client** (manage policy makes it visible to members).
  Dialog `hint` notes any corp member can see and manage the share.

### 6. What this deliberately does NOT do

- **No union on the account page.** an account's page keeps showing only
  character-owned BPOs; corp holdings live at the corp URL. Merging them would
  let one member's personal share expose corp property (and vice versa), and
  double-count when two members share the same corp.
- No per-hangar/division filtering — the corp's whole original collection, same
  as the account page pools alts.
- No changes to extract jobs, ESI scopes, or `shareToken.ts`.

## Work items

1. Migration + `schema.sql`: `corp_bpo_share` (table, RLS, grants).
   `pnpm run db:new corp_bpo_share`.
2. `slug.ts`: nothing (helpers already name-agnostic); rename nothing.
3. `access.ts`: `BposSubject`, `resolveBposSubject` (corp → account),
   corp branch of `bposAccess` (`member` access kind).
4. `data.ts`: shared `dressStacks`, new `fetchCorpBpoEntries`.
5. `shareData.ts` / `shareActions.ts`: corp variants (`corp_bpo_share`,
   `onConflict: 'corporation_id'`, membership check).
6. `[name]/page.tsx`: branch on subject kind; wire corp share dialog.
7. Tests:
   - `test/bposSubject.test.ts` — pure resolution-order/narrowing logic if a
     pure seam falls out (candidate: the "narrow probe rows by exact slug, pick
     unique" step, shared by both resolvers).
   - `test/sql/corp_bpo_share.sql` — RLS: member manages, non-member can't
     write, audience policy matches corp/alliance arrays, link-only row
     invisible to anon.
8. Verify: `pnpm run lint`, `pnpm test`, `next build`; `test:sql` against a
   throwaway DB.
