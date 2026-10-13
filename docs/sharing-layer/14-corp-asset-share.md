# Phase 14: corp asset shares

**Status: ✅ built.** All five PRs: the location split, the share table, the
widening policy, the dialog/links/card, and GraphQL/MCP.

Today a corporation's hangar cannot be shared at all. `/asset/1052154845801`
(a Station Warehouse Container held by corporation 98127666) renders for any
member, but no Share button appears: the dialog is gated on
`fetchShareDialogData`, which proves ownership by matching the item's
`registration_id` against the caller's registrations, and a corp item has
none. That is the whole corp-side story — `character_asset_share` is keyed
on a registration, `asset_share_covers()` walks `character_asset_version`,
and phase 02 named corp assets a non-goal.

This phase gives corp-owned assets the **same share, in the same shape**: one
row per shared item on a `_share` sibling table, the Revision 3 audience
columns, a recursive widening policy, the same dialog, the same `?share=`
link, the same card. A member who has used the character share should find
nothing new to learn. The one difference is the one the subject forces: who
the grantor is.

## What a corp share decides differently

### Grantor: the corporation, with a registration for audit

`design.md` already settled this: "For corp-owned data it's the
**corporation** (`corporation_id`), with a `created_by` user for audit." A
share row belongs to the corp, not to whoever clicked — if the member who
minted it leaves, the share stands until another member stops it, the way
the corp's extract keeps running on the next director's token.

The audit column is a **registration**, never a `user_id`: it must not be
readable by anyone outside the account, and the owner-side policies only read
it to answer "is the caller allowed to touch this row", never to show it.

### Who may grant: any member — they can already see it

The read policy on `corp_asset_over_time` is `corporation_id in
my_corporation_ids()`: every member of the corporation reads the whole corp
hangar here. The grant predicate is the same one. Whoever can see the item can
share it, edit the share, or stop it — the corp's data, the corp's members,
one rule in both directions.

```sql
-- Every owner-side policy on corp_asset_share: the caller has a character in
-- the row's corporation. The same predicate that lets them read the hangar.
corporation_id in (select public.my_corporation_ids())
```

Invoker rights, no new helper: `my_corporation_ids()` already exists and
is what every corp_* policy trusts.

Noted and accepted: this read is already wider than the game (a
Director-scoped token pulls every division; in-game a member sees only the
hangars their roles open), so a member can publish a hangar they could not
open in the client. The decision is that visibility here _is_ the trust
boundary — the corporation chose to link a director's token to this account's
corp, and anyone the corp let in can see what it sees. If that ever needs
tightening, the predicate is one line and `corp_job_access` (`job =
'corp-assets'`, the registration whose token the hangar came through) is the
ready-made proof of Director to swap in; no other part of this plan would
change.

**Rejected:** `created_by` alone as the only editor (a share should outlive
its author); a director-only gate (above — available later without
restructuring); a stated role from
`esi-characters.read_corporation_roles.v1` (needs every linked character to
re-auth).

## PR 1 — the location split for corp assets

`corp_asset_over_time` carries a root item's place inline (`location_id`,
`location_type`, `location_flag`), with none of the phase 11 separation. A
widening policy returns whole rows, so without the split a shared corp
container's own row hands its station or structure to every recipient — and
a public share hands it to the anon key. Phase 11 decided that is not
acceptable for characters; it is not acceptable for a corporation's hangar
either, where the place is the corp's office.

Mirror phase 11 exactly, so the two hangars read the same way:

| Object | What it is |
| --- | --- |
| `corp_asset_version` | The table, renamed from `corp_asset_over_time`. Location columns hold only a parent that is another asset of the **same corporation**; null on a root item. |
| `corp_asset_location` | The root item's place, 1:1 with the version row (`asset_id`), same SCD-2 history. RLS: **members only** (the same `my_corporation_ids()` predicate the table carries today). `anon` gets the grant and no policy. |
| `corp_asset_over_time` (view) | Security-invoker `UNION ALL` of parent rows and root rows joined to their place. Same columns, same order. |
| `corp_asset` (view) | Current rows of the view above, as before. |

Everything phase 11 touched has a corp twin to touch:

- **Writes.** `corp_asset_claim()` inserts version rows, then moves each
  root's place into the location table, with the same relink rule (a current
  place row whose `location_id` is an item just inserted becomes a parent
  link again — the 1000-row chunking makes contents arrive before their
  container here too). The extract's `is_current`/`valid_until` updates in
  `src/jobs/corpAssets.js` target `corp_asset_version`.
- **Walks** join the version table directly: the recursive steps of
  `corp_asset_location_summary`, `_contents`, `_subtree_items` (both
  arities), `_search`, `_filter`, `_filter_at`, `_location_summary_at`,
  `corp_assets()`, the corp branches of `asset_ancestors()`, and
  `refresh_asset_location_summary_cache` /
  `refresh_asset_location_summary_cache_for_corporation`. Seeds ("what is at
  this place") stay on the view, which is what keeps a recipient's walk from
  starting at a station.
- **Other readers** of the table name: `src/jobs/universeStructures.js`,
  `src/resolveNames.js`, `src/workflows/corpAssets.ts`,
  `test/sql/asset_filter.sql`, `asset_filter_at.sql`,
  `asset_location_summary_cache.sql`.
- **The one assumption** carries over — a place id never equals an item id
  of the same corporation. Verify it against production before the backfill
  like phase 11 did (it recorded "no item id in the station/system range").
  One corp-specific check: confirm from a real listing whether items in a
  corp hangar name the **station/structure** or the **Office item** as their
  `location_id`. Either way the root rule holds (the root is the first
  `location_id` that is not an asset of the same owner — an Office is one),
  but the split's root detection and the breadcrumb must agree on it.
- **Rename mechanics.** A table rename never renames its constraints or
  identity sequence; discover the primary key, the FK and the sequence from
  the catalogs first, as `20260926054546_asset_location_split.sql` does.

Measure before and after, the phase 11 table: children of a container, items
at a structure, `corp_asset_location_contents`, `asset_ancestors` on a corp
item, `corp_asset_search`. The corp table is far smaller than the character
one, so this should be the cheap half of the plan.

### As built

Migration `20261013042029_corp_asset_location_split.sql`, tested by
`test/sql/corp_asset_location_split.sql` (backfill, a member reads exactly the
rows they read before the split, every rewritten walk, a non-member, the claim
and its relink, the close stamp).

Production, checked before writing (2026-10-13): 226k rows (85k current,
70 MB), 15 corporations; no item id in the station/system range (the smallest
is 101,430,574); no current row whose parent is only history. **Hangar items
name the Office**: CorpSAG1–7 rows link to the corporation's Office item
(type 27), and the Office (`OfficeFolder`) is the root that names the station
or structure — so the split files offices as roots and everything in a hangar
as parent links, and the breadcrumb still reads item → container → Office →
station. Nine rows link to an item another corporation held; by the
same-owner rule those are roots whose place is that item's id, which is how
the summary walk already read them.

What changed beyond the plan's list: `corp_asset_location_summary()`,
`corp_assets()` and the two summary-cache refreshers are untouched — they read
the `corp_asset_over_time`/`corp_asset` views and get the same rows, as their
character twins did after phase 11. The extract keeps reading its current
rows through the view and writes its closes to `corp_asset_version`.

Measured on a synthetic hangar shaped like production (200k rows, 76k current,
15 corps × 12 offices × 25 containers × 17 items, ~1.6 closed versions per
item), as a member under RLS, local Postgres 15, median of three:

| Query | Before | After |
| --- | --- | --- |
| The migration itself (backfill included) | — | ~0.2 s |
| Children of a container | 0.2 ms | 0.7 ms |
| Items at a station | 0.15 ms | 0.35 ms |
| `corp_asset_location_contents(station)` | 0.9 ms | 1.1 ms |
| `asset_ancestors` (corp breadcrumb) | 0.6 ms | 0.55 ms |
| `corp_asset_search` | 28 ms | 35 ms |
| `corp_asset_location_summary()` (live) | 29 ms | 105 ms |

The live summary pays for reading the view twice; `/asset` reads the summary
cache, and only MCP `browse_assets` calls the live function.

No rollback script was written (phase 11 has
`docs/sharing-layer/rollback-location-split.sql`); the in-migration
fingerprint check is the guarantee, and the corp tables are small enough to
`pg_dump` before merging:

```
pg_dump "$DATABASE_URL" --data-only -t public.corp_asset_over_time | gzip > corp-assets-before-split.sql.gz
```

**This PR changes no visible behaviour.** It is the whole reason the later
widening policy can be the three-line twin of phase 02 rather than a special
case.

## PR 2 — `corp_asset_share`

Pure additive schema, nothing reading it yet (phase 01's shape):

```sql
create table public.corp_asset_share (
  id uuid primary key default gen_random_uuid(),
  -- Grantor: the corporation holding the item. The row is the corp's, not
  -- its author's — any member of the corp can change or stop it.
  corporation_id bigint not null,
  -- Audit: the registration that created it. The insert policy reads it
  -- only to prove the author is the caller's; nothing ever displays it.
  created_by uuid not null references public.registration(id) on delete set null,
  -- Subject: the shared item; covers it and, recursively, everything inside.
  item_id bigint not null,
  corporation_ids bigint[] not null default '{}',
  alliance_ids bigint[] not null default '{}',
  secret text,
  created_at timestamptz not null default now(),
  unique (corporation_id, item_id)
);
create index corp_asset_share_item_id_idx on public.corp_asset_share (item_id);
```

No `show_as_main`: the owner shown is the corporation, and a corporation has
nothing to hide behind. (`created_by` is `on delete set null`, not cascade:
a member's account closing must not silently end the corp's share.
Relax `not null` accordingly, or default it — decide in the PR.)

Policies, mirroring `character_asset_share` with the membership predicate in
place of the registration one:

- **read / create / update / delete own** — `corporation_id in (select
  my_corporation_ids())`, repeated on `with check` so a row can't be
  re-pointed at another corp; `create` additionally checks `created_by in
  (select id from registration where user_id = auth.uid())`, so the audit
  column names one of the caller's own characters.
- **audience read**, load-bearing, `to anon, authenticated`:
  `share_audience_matches(corporation_ids, alliance_ids, secret)` — verbatim.

Grants as phase 01: `select` to `anon`; `select, insert, update, delete` to
`authenticated`; `all` to `service_role`.

`test/sql/corp_asset_share.sql`, from the `asset_share.sql` harness: a member
of corp A reads, inserts, edits and deletes A's rows; cannot insert for corp
B; cannot set `created_by` to another account's registration; a
non-member reads nothing; audience matching is the shared helper's, so one
public/corp/alliance/link-only assertion each is enough.

### As built

Migration `20261013062951_corp_asset_share.sql`, tested by
`test/sql/corp_asset_share.sql` (the grant; the audit guard both ways — another
account's registration and none at all; another corporation's hangar refused; a
corp-mate on a second account reading, editing and able to stop a share they did
not create, with `created_by` left alone; the row refused a new
`corporation_id`; an outsider's delete seeing nothing; one assertion each for
the corp, alliance, link-only and fully-public audiences; and the author's
registration deleted, leaving the share standing with `created_by` null).

`created_by` is **nullable**, which is how the plan's two halves are reconciled:
`on delete set null` needs it, and the insert policy supplies the guarantee
instead — `created_by in (select id from registration where user_id =
auth.uid())` is null-false, so a row cannot be created without naming one of the
caller's own characters. Only time can null it, by the author's account closing.

Nothing reads the table yet, so there is no behaviour to measure; the audience
policy's cost lands on `corp_asset_version` in PR 3, where the plan already says
to `explain analyze` a member's read.

## PR 3 — the widening policy

The second sanctioned SECURITY DEFINER, for exactly phase 02's reason — a
policy on `corp_asset_version` whose helper climbs `corp_asset_version`
recurses — and safe for exactly phase 02's reasons: one boolean, parentage
columns and the share table only, audiences through
`share_audience_matches()` which resolves `auth.uid()` to the caller inside
the definer, pinned `search_path`, revoked from `public`.

```sql
create or replace function public.corp_asset_share_covers(item bigint, corporation bigint)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with recursive
    matching_shares as (
      select s.item_id
      from corp_asset_share s
      where s.corporation_id = corp_asset_share_covers.corporation
        and share_audience_matches(s.corporation_ids, s.alliance_ids, s.secret)
    ),
    walk (node, depth) as (
      select corp_asset_share_covers.item, 0
      union all
      select parent.location_id, w.depth + 1
      from walk w
      cross join lateral (
        select o.location_id
        from corp_asset_version o
        where o.item_id = w.node
        order by o.is_current desc, o.valid_until desc
        limit 1
      ) parent
      where w.depth < 16
        and parent.location_id is not null
        and exists (select 1 from matching_shares)
    )
  select exists (select 1 from walk w join matching_shares m on m.item_id = w.node);
$$;

create policy "Audience reads shared corp assets"
  on public.corp_asset_version
  for select
  to anon, authenticated
  using (is_current and public.corp_asset_share_covers(item_id, corporation_id));

grant select on public.corp_asset_version to anon;
```

Seeded by the grantor corporation, so an unshared corp's rows short-circuit
on one indexed probe. Depth 16, `is_current` on the policy, current view
only — all as phase 02.

**Performance, the thing to measure before merging.** Phase 11 recorded that
the OR'd audience policy makes the owner index unusable on the character
table (~2.3 s per scan at 180k rows; the reason
`refresh_asset_location_summary_cache` is a definer). The same happens to
`corp_asset_version_corporation_id_idx` for members' reads. Likely fine —
the corp table is small and `/asset` reads the cache, which is refreshed by
a definer the policy never enters — but `explain analyze` a member's
`corp_asset` select and `corp_asset_location_contents` over the largest corp
in production, and keep the numbers in this doc.

The walk RPCs are SECURITY INVOKER, so a recipient's `corp_asset_location_contents`
/ `_subtree_items` / `asset_ancestors` over the shared subtree just work —
verify, don't assume (the `/asset/[locationId]` contents counts and
`collectAssetLines.ts` are the acceptance tests, as in phase 02).

`test/sql/corp_asset_share.sql` grows the phase 02 assertions: nested item
visible through a shared grandparent; sibling container not; revoke closes;
depth cap; a policy-level smoke as `authenticated` proving no recursion; and
**the location assertion** — a recipient reading the shared root through
`corp_asset` gets `location_id` null.

Two-account test: B sees the container A's corp shared, and its contents,
on `/asset/[id]` opened as B; nothing else from that corp; anon sees a public
share signed-out; the breadcrumb for B ends at the shared root.

### As built

Migration `20261013064401_corp_asset_share_recursive_rls.sql`, tested in
`test/sql/corp_asset_share.sql`.

**The per-row shape above is not what shipped.** `asset_share_covers(item,
registration)`'s twin climbs from the candidate row, so the policy runs a
recursive walk for every row the member policy does not already grant. Phase 11
measured that on the character table (~2.3 s per scan) and accepted it; on the
corp table it is worse than "slow", because `authenticated` carries an 8 s
`statement_timeout` and the live `corp_asset_location_summary()` — which MCP
`browse_assets` calls — crossed it.

So the walk runs **once per query and descends**:

```sql
create or replace function public.corp_shared_item_ids()
returns setof bigint language sql stable security definer set search_path = public
-- every item id the caller's visible shares cover: the shares matching the
-- caller, then their children, 16 levels down, never leaving the grantor corp
as $$ … $$;

create policy "Audience reads shared corp assets"
  on public.corp_asset_version for select to anon, authenticated
  using (is_current and item_id in (select public.corp_shared_item_ids()));
```

Being argument-free and `stable`, the planner evaluates it once into a hashed
subplan instead of per row — the same shape as `my_tenant_structure_ids()` in
the co-tenant job policies, so it is house style rather than a new idea. Three
things make it equivalent rather than merely cheaper:

- **Testing `item_id` alone is sound.**
  `corp_asset_version_current_item_idx` is unique on `(item_id) where
  is_current` across every corporation, and the policy grants current rows only
  — so an id in the covered set identifies exactly one row, and a share cannot
  reach another corporation's hangar. The descent also carries the grantor
  corporation (`c.corporation_id = w.corporation_id`), which is what the test's
  item 500 pins: a row of corp B naming corp A's shared container as its parent
  stays invisible.
- **It is still the sanctioned SECURITY DEFINER**, for phase 02's reason (a
  policy's helper reading the table it guards recurses). The safety argument
  shifts by one word: it no longer returns a boolean but a set of item ids —
  and every id in it is an id the policy is about to grant, so it is the grant
  itself rather than a window past it. It still reads only parentage columns
  plus the share table, resolves audiences through `share_audience_matches()`
  (whose `my_*_ids()` see the CALLER inside the definer), pins `search_path`
  and is revoked from `public`. It never reads `corp_asset_location`.
- **One semantic difference, deliberate.** The descent follows **current**
  children, where the upward walk took each item's best-known parent and so
  bridged a container that momentarily left the snapshot. Either way the policy
  grants current rows; the difference is that an item whose container has no
  current row is uncovered until the next extract restores it. Bridging gaps
  downward needs the `distinct on (item_id)` parent map, which is a full-table
  read — the thing that makes the live summary cost 120 ms, and far too much for
  a policy.

Measured on a synthetic hangar shaped like production (211k rows, 81k current,
15 corps × 12 offices × 25 containers × 17 items, ~1.6 closed versions per item;
production is 226k/85k/15), as a member under RLS, local Postgres 15, median of
six. **Every corporation holds a share** — the worst case for the per-row shape,
since a corp that shares nothing short-circuits on one probe:

| Query | No policy | Per-row (planned) | Set-based (shipped) |
| --- | --- | --- | --- |
| Member's hangar, explicit corp filter | 21 ms | 12 ms | 35 ms |
| Member's read, RLS-only scoping | 29 ms | **5,565 ms** | 50 ms |
| Children of a container | 0.5 ms | 0.4 ms | 0.6 ms |
| Items at a station | 15 ms | 5 ms | 16 ms |
| `corp_asset_location_contents(office)` | 1.0 ms | 0.9 ms | 1.2 ms |
| Live `corp_asset_location_summary()` | 120 ms | **19,900 ms** | 177 ms |
| Recipient: items in a shared container | — | 1.1 ms | 1.4 ms |
| Recipient: `_location_contents(shared container)` | — | 1.1 ms | 1.5 ms |

The shipped policy costs 1.2–1.7× baseline everywhere; the planned one is 190×
on an unfiltered member read and 165× on the live summary, both past the 8 s
timeout. (The per-row column is *faster* than baseline on two rows: the OR'd
filter turns the member predicate from a semi-join into a hashed subplan, which
happens to let branch 3 of the view use `current_location_idx` instead of a
211k-row index scan. That is a pre-existing inefficiency in the view, not a gain
from sharing. The last two rows have no baseline — with no policy a recipient
reads nothing.)

The phase-11 worry — the OR'd audience policy making
`corp_asset_version_corporation_id_idx` unusable — did not materialise: the
index is still chosen for a member's filtered read. What the policy does cost is
the unfiltered shape, and that lands on the live summary only;
`refresh_asset_location_summary_cache` is a SECURITY DEFINER the policy never
enters, and `/asset` reads the cache it fills.

The walk RPCs needed no change: they are SECURITY INVOKER, so a recipient's
`corp_asset_location_contents` and `asset_ancestors` work through the shared
subtree, which the test asserts alongside the location assertion (a recipient
reads the shared root with `location_id` null, and the parent it cannot see as
null, while a link inside the subtree still reads through).

Still owed before this is proven in production: the two-account check on a real
deployment (B sees the container A's corp shared and nothing else; anon sees a
public share signed out; B's breadcrumb ends at the shared root), which needs
PR 4's dialog to mint a share through the UI.

## PR 4 — the dialog, the links, the card

The user-facing half, and where "similar in structure" pays off: no new
component.

**Dialog.** `ShareDialog` is already generic (`subjectLabel`, `urlPath`,
bound actions, optional `hint`). Add `fetchCorpShareDialogData(supabase,
itemId)` beside `fetchShareDialogData` in `src/app/asset/shareData.ts`:
returns null unless the item is in `corp_asset` and its corporation is one
of the caller's own (`registration.corporation_id` over the RLS-scoped
registration read — the same rows `fetchShareAudiences` already loads);
otherwise the same `ShareDialogData` shape minus `mainName`. Audiences come
from `fetchShareAudiences` unchanged.

Both pages gate the same way they do now, with one more arm:

```ts
const shareDataPromise = scope ? null
  : isOwnCharacterItem ? fetchShareDialogData(supabase, locationId)
  : fetchCorpShareDialogData(supabase, locationId)
```

`/asset/[locationId]/page.tsx` already knows `isOwnCharacterItem`; the corp
arm is where the container from the opening paragraph gets its button.
`/ship/[itemId]/page.tsx` has `corpSelf` in hand and does the same, so a corp
hull gets the button too. Every member sees the button, and the dialog opens
on the corp's one row — so a member finds a share a corpmate set up already
in place, and can change or stop it.

The hint line: _"Whoever you share with can see this item and everything
inside it, live, until a member of {corp} stops sharing."_ The one sentence
that tells the user this share is the corporation's, not theirs.

**Server actions.** `saveCorpAssetShare` / `revokeCorpAssetShare` in
`src/app/asset/corpShareActions.ts`, the twins of `shareActions.ts`:
cookie-session client, never the service role; `ownCorpItem` guard (item in
`corp_asset`, corporation among the caller's registrations' corps,
`created_by` = one of the caller's registrations in that corp — the row's
existing `created_by` is kept on update); requested audience ids filtered
to ones the caller has; secret minted/rotated the same way; upsert on
`(corporation_id, item_id)`; `revalidatePath` both pages. No legacy
`shared_asset_token` to retire — corp items never had one.

**Signed links.** `resolveSignedShare` in `src/app/asset/access.ts` climbs
`character_asset_over_time` and probes `character_asset_share`. An item lives
in exactly one of the two tables, so: probe `character_asset_version` for
the item; if absent, climb `corp_asset_version` instead and probe
`corp_asset_share` over that chain, verifying the signature the same way. A
corp hit returns `ShareScope { registrationIds: [], corporationIds: [corp],
characterNames: empty, showAsMain: false }`. Everything downstream already
copes: `fetchRootItems`/`fetchSelf` take `corpScope`, `fetchScopeOwners`
names corporations, `presentedAsMain` is skipped when `showAsMain` is false,
and `sharedShip.ts` has a corp arm.

**The card and the outlived hull.** `sharedShip.ts` reads the corp hull from
the `corp_asset` view (current only), which is why the doc comment says a
corp ship on a link "still goes dead". With PR 1's version table it can read
the newest open-or-closed row and `childrenAsOf` from `corp_asset_version`
exactly as the character arm does, and the sighting line comes from the
`corp-assets` heartbeat it already asks for. Do that here so the two kinds of
link behave the same.

### As built

As planned, with no new component: `ShareDialog` took the corp writers unchanged.

- **`fetchCorpShareDialogData`** sits beside `fetchShareDialogData` in
  `src/app/asset/shareData.ts` and returns the same shape minus `mainName`,
  plus the grantor's `corporationName` for the hint. Membership is proven from
  the RLS-scoped `registration` read, not from being able to see the item — PR
  3 made a shared corp item readable by its audience, so visibility would now
  offer a recipient the dialog for someone else's corporation.
- **`AssetShareDialog`** (`assetShareDialog.tsx`) is the one place a Share
  button picks its writer, so both pages stay a single line. The choice and the
  hint are the pure `corpShareSubject.ts` next door — `isCorpShare` keys on
  `corporationName`, the field only the corp payload carries — and
  `test/corpShareSubject.test.ts` pins both (bind a corp item to the character
  writer and the save is simply refused, which is worth a test rather than a
  reading).
- **Both pages** fetch exactly one of the two, since an item is in exactly one
  hangar: `/asset/[locationId]` on `isOwnCharacterItem`, `/ship/[itemId]` on
  whether the hull came back from `character_asset`. So the Station Warehouse
  Container from this document's opening paragraph now has a Share button, and
  so does a corp hull.
- **`corpShareActions.ts`** mirrors `shareActions.ts`: cookie-session client,
  `ownCorpItem` guard, requested audiences filtered to the caller's own, secret
  minted/rotated the same way, `revalidatePath` on both pages. Insert and
  update are **separate rather than one upsert** — `created_by` names whoever
  first shared the item, and a corpmate editing their share must not rewrite
  it (PR 2's SQL test asserts the row keeps its author through a corpmate's
  edit). Revoke is a plain delete scoped by RLS, so any member can stop it.
- **Signed links**: `resolveSignedShare` tries the character tables first and
  falls through to `corp_asset_version` / `corp_asset_share` for an item they do
  not hold, verifying the signature identically. The scope it returns names the
  grantor corporation and **no** registration, so every downstream query stays
  inside that corporation's rows; `showAsMain` is false, since a corporation is
  the owner it would otherwise hide behind. `userId` is the author's account
  when `created_by` still names one, and empty when that account has closed —
  nothing in the corp path keys off it.
- **The card and the outlived hull**: `sharedShip.ts` now reads the corp hull as
  the newest open-or-closed row of `corp_asset_version`, with `childrenAsOf`
  generalised over both hangars, so a corp link behaves exactly like a
  character's and the sighting line comes from the `corp-assets` heartbeat it
  already asked for. Only a legacy `?token=` link, which scopes to a whole
  account, still lets a corp hull go dead with its row.

One behaviour change beyond the plan, deliberate: a shared hull's contents now
come from **its own hangar** rather than a union of both. The file already
stated the invariant ("everything inside a ship belongs to whoever owns the
ship"), the union existed only because the loader did not branch, and it costs
a query. The visible difference is confined to legacy `?token=` links, the one
scope that spans an account's characters *and* corps.

Verified: `pnpm run lint`, `pnpm test` (878, four new), `pnpm exec tsc --noEmit`
clean of everything but the two pre-existing macOS-only errors. **The
two-account leak test is still owed** — it needs two real accounts against a
deployment, which this working copy cannot do: B opening the container A's corp
shared (and nothing else of that corp), anon on a public share signed out, and
B's breadcrumb ending at the shared root. The SQL test covers the same ground at
the RLS layer, where the leak would have to originate.

## PR 5 — GraphQL and MCP

What phase 04 gave the character share, for corp rows.

- `assets(includeShared:)` widens `corporationIds` with the grantor corps of
  the `corp_asset_share` rows the caller can read (the audience policy), the
  way `grantorRegistrationIds` widens registrations, and lets RLS decide.
  Session mode only; the token-mode error is unchanged.
- `sharedWithMe` gains corp grants: `ownerName` from the world-readable
  `corporation` directory, `ownerId` the corporation id, plus whatever
  discriminator the type already uses for corp-owned rows.
- MCP `search_assets` / `list_assets` / `browse_assets` use the SECURITY
  INVOKER RPCs, so shared corp rows appear once PR 3 lands; the `_at`
  variants and `assetFilterQuery.ts`'s explicit owner lists exclude shared
  rows by design, as they do for character shares. `appraise_assets` stays
  live-only. Nothing to add beyond a test.

### As built

- `assets(includeShared:)` reads the grantor corporations off
  `corp_asset_share` (`grantorCorporationIds`, the caller's own corporations
  dropped, since a member reads every share row of their corp) and widens the
  corp side's `.in('corporation_id', …)` with them. An owner filter that
  shuts the corp side out keeps the shared corp rows out too, as one that
  shuts the character side out does for character shares.
- `sharedWithMe` reads both share tables. `ShareGrant` gained the corporation
  trio every corp-ownable row carries (`corporationId`, `corporationName`,
  `corporation`), and `ownerType` is `corporation` for a corp grant.
- The context's corporation memo is per id and takes extra ids, so a grantor
  corporation — outside the caller's own — gets its name and alliance on the
  row and on the `Corporation` edge.
- MCP: unchanged, as planned. One consequence worth knowing: the live
  `*_asset_search`/`*_asset_filter` RPCs inner-join each item to its root
  place, which a recipient cannot read, so a shared item does not appear in
  `search_assets`/`list_assets` — the same deliberate behaviour phase 11
  recorded for character shares. `browse_assets` drilling into a shared
  container's id does list its contents.

## Non-goals

- Sharing the **place** of a corp item. `corp_asset_location` is the home of
  a later "share the location too" feature, with its own rules — PR 1 gives
  it a table, nothing opens it.
- A per-division grant ("share CorpSAG3 only"). The subject is an item; a
  hangar division is a flag on root rows, not a container. Sharing a
  division would need a different subject and gets its own doc if wanted.
- Gating the grant on Director. See above — one predicate swap if ever
  wanted, with `corp_job_access` as the proof.
- Folding `character_asset_share` and `corp_asset_share` into one table with
  an owner-kind discriminator. Every other subject in this layer keeps the
  character/corp split the extract tables have; a union here would be the
  one place the pattern bends.

## Verification (every PR)

`pnpm run lint && pnpm test && pnpm run build`; `supabase db push` applies
cleanly; schema changes dual-written to `schema.sql` and a fresh
`pnpm run db:new` migration (never a copied timestamp, never a rename);
`pnpm run test:sql` against a throwaway database. The two-account leak test
per PR from PR 3 on. Update the Database section of `CLAUDE.md` when the
tables land.
