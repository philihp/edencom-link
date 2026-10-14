# Phase 16: industry job shares — a quiet per-job opt-out, and share rows over a whole scope

**Status: 📝 planned.** Nothing here is built. Five PRs; each one leaves
production working. Supersedes the opt-in grant and the `jobs` level of
[13-industry-job-share.md](13-industry-job-share.md) (its `totals` pool stays
unbuilt and is not planned here).

## Open questions for the owner

Decisions this document makes that the owner should confirm or overturn. Each
is also marked **Owner's call** where it is argued below.

1. **Does hidden also exclude a job from the shares of this phase?**
   Recommended **yes**: one flag, one meaning — a hidden job is seen by its
   owner and nobody else, whichever grant would otherwise reach it. The
   alternative (hidden opts out of the co-tenant default only, and an explicit
   share still carries the job) is a one-token change in each widening policy.
2. **Who may toggle `hidden` on a corp job, and who may create a corp jobs
   share?** Recommended **any member of the corporation** (phase 14's rule:
   whoever can read the corp's rows can share them), with `corp_job_access
(job = 'corp-industry-jobs')` named as the ready-made Factory Manager proof
   to swap in if that should be directors only (phase 12's rule). The
   alternative for the flag alone — only the job's installer — is also
   possible, since `installer_id` is on the row.
3. **Does a share recipient see where a job runs?** Recommended **yes**, as
   co-tenants do today: `station_id`/`facility_id` stay on the row. The asset
   layer hides a root's place from recipients (phase 11); a job list without
   its structures is a different product, and the owner can hide any job whose
   location is the sensitive part. Masking the location for non-tenant
   recipients would be one more `case` in the two views, like `cost`.
4. **Does a character-jobs share offer "show the owner as the main"?**
   Recommended **yes**: the subject spans the account's alts, so this is the
   one share where collapsing the owner column to the main does real work. The
   data layer still hands recipients each row's `registration_id` (phase 15's
   posture); only the pages present the main.
5. **`cost` stays masked for recipients.** Not offered as an option on the
   share: `cost` inverts to the structure's tax rate, and a public share would
   publish it. Listed so the owner can overrule.

## Problem

Phase 13 shipped on 2026-10-08 as "co-tenancy is the grant": everyone with a
job at a player structure in the last 30 days reads the current job rows of
everyone else building there, through a tenant policy on both job tables, with
`cost` masked in the two views. That default stays. It is wrong in two
directions, though, and this phase fixes both:

- **There is no way out for one job.** A supercapital build at a shared
  structure is visible to every co-tenant, and the only remedy is to build
  somewhere else. The owner wants a quiet per-job opt-out: mark the job
  hidden, and it stops appearing — nothing tells the co-tenants it was there.
- **There is no way in for anyone else.** A co-tenant sees a job; a corpmate
  at another structure, an alliance industry channel, or a recruiter with a
  link sees nothing. Every other subject in this layer can be shared with
  corporations, alliances, a signed link or everyone. Jobs cannot.

Phase 13's planned opt-in grant was per character and per structure, with a
pool nobody asked for. The owner's ask is simpler and bigger: a share covering
**all** of a scope's jobs — a corporation's, or every character of an
account's — past and future, on the Revision 3 shape.

## Design in one paragraph

A job row is visible to its owner; to a co-tenant of the structure it runs at
**unless it is hidden**; and to the audience of a share covering its scope
**unless it is hidden**. `hidden` is a column on the job row, owner-writable
through a column-level grant, carried forward across SCD-2 versions by a
trigger, and tested by the two existing tenant policies and the two new share
policies with one extra conjunct each. Shares are two sibling tables on the
Revision 3 audience shape: `corp_industry_job_share`, keyed on the corporation
with phase 14's `created_by` author gate, and `character_industry_job_share`,
anchored on one registration and reaching the whole account through one
argument-free SECURITY DEFINER of the `asset_sharing_registration_ids()`
shape. A share has no subject column — its subject is every current job of the
scope, now and later, which is what a policy-based grant gives for free. The
views keep masking `cost` for everyone but the owner.

## Part 1 — the quiet opt-out: `hidden`

### The flag is a column on the job row

```sql
alter table public.character_industry_job_over_time
  add column hidden boolean not null default false;
alter table public.corp_industry_job_over_time
  add column hidden boolean not null default false,
  -- The member who last toggled it; one of the caller's own characters in the
  -- corporation (the with check below). Audit only, never shown.
  add column hidden_by uuid references public.registration (id) on delete set null;
```

Why a column rather than a side table:

- **It enters the policies without recursion or a scan.** The tenant policy
  already evaluates per candidate row; `and not hidden` reads the row it is
  already holding. A side table keyed on `job_id` would be the owner's row,
  which the co-tenant's RLS cannot read — so the policy would need either a
  world-readable table of hidden job ids (which tells a co-tenant exactly what
  "quietly" says they must not learn: that the job they were watching was
  hidden rather than gone) or a SECURITY DEFINER returning the set of every
  hidden job id in the system. The column needs neither.
- **No new SECURITY DEFINER.** The layer's count of sanctioned definers stays
  where phase 15 left it for this half of the phase.
- **"Quietly" holds by construction.** A hidden job's row is simply not
  granted. Nothing a co-tenant can query distinguishes hidden from delivered
  and aged out, and `structure_tenant` is untouched — the owner is still a
  tenant, still sees the co-tenants' jobs, and their jobs still move the
  system's cost index, which is the reason the default exists.

What a column costs: the extract opens a new version row whenever a job's
state advances (`industryJobReconcile.js`), and that insert knows nothing about
`hidden`. The flag must survive the versioning.

### Carry-forward across versions: a trigger

The first trigger in `schema.sql`, and deliberately in SQL rather than in the
JS reconcile: a flag that lapses when a job goes `active → ready` would unhide
the job at the exact moment the owner cares, and the reconcile is shared by
two job modules that would both have to get it right forever.

```sql
create or replace function public.industry_job_inherit_hidden()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- The newest version of this job, current or not: the owner's update sets
  -- every version (below), so any one of them carries the truth.
  select coalesce(
    (select j.hidden from public.character_industry_job_over_time j
      where j.job_id = new.job_id
      order by j.is_current desc, j.valid_until desc
      limit 1),
    false)
  into new.hidden;
  return new;
end;
$$;

create trigger character_industry_job_inherit_hidden
  before insert on public.character_industry_job_over_time
  for each row execute function public.industry_job_inherit_hidden();
```

The corp table gets the twin (reading `corp_industry_job_over_time`, carrying
`hidden_by` as well). The lookup is one probe on the existing
`(job_id, valid_until desc)` index, and the reconcile closes before it inserts,
so the row it finds is the one just closed. Fires only on insert; the extract's
`valid_until` touches and closes are updates and never see it.

### Owner-writable under RLS: a column-level grant plus an update policy

`authenticated` has never written to an extract table. Keep that nearly true:
it may update exactly one column.

```sql
grant update (hidden) on public.character_industry_job_over_time to authenticated;
create policy "Users hide own industry jobs"
  on public.character_industry_job_over_time
  for update
  to authenticated
  using (registration_id in (select id from public.registration where user_id = (select auth.uid())))
  with check (registration_id in (select id from public.registration where user_id = (select auth.uid())));

grant update (hidden, hidden_by) on public.corp_industry_job_over_time to authenticated;
create policy "Members hide own corp industry jobs"
  on public.corp_industry_job_over_time
  for update
  to authenticated
  using (corporation_id in (select public.my_corporation_ids()))
  with check (
    corporation_id in (select public.my_corporation_ids())
    and hidden_by in (
      select r.id from public.registration r
      where r.user_id = (select auth.uid()) and r.corporation_id = corp_industry_job_over_time.corporation_id
    )
  );
```

The server action writes `update … set hidden = true where job_id = $1`, which
hits **every version** of the job the caller owns — history included — so the
trigger above can read any of them, and so time-travel reads of the owner's
own history agree with the live view. A write from a user who does not own
the job matches no row (RLS) and a write to any other column is a permission
error (the column grant). `with check` repeats the owner predicate so a row
cannot be re-pointed, which `update (hidden)` could not do anyway; it is there
so the two policies read like every other owner policy in the layer.

**Corp jobs.** Several members can toggle the same flag; last writer wins, and
`hidden_by` says who. A hidden corp job stays hidden when `hidden_by` leaves
the corporation — the author gate (phase 14) lapses a _grant_ when its author
leaves, and `hidden` is a restriction, so the safe direction is to keep it.
**Owner's call (question 2):** member-manage follows `corp_asset_share`; the
installer-only alternative is `installer_id in (select character_id from
registration where user_id = auth.uid())`, and the director alternative is the
`corp_job_access` predicate from phase 12 with `job = 'corp-industry-jobs'`.

### Where it enters the policies

The two shipped tenant policies gain one conjunct:

```sql
create policy "Tenants read industry jobs at shared structures"
  on public.character_industry_job_over_time for select to authenticated
  using (
    is_current
    and not hidden
    and coalesce(station_id, facility_id) in (select public.my_tenant_structure_ids())
  );
```

(`corp_industry_job_over_time` the same.) The owner policies do not test it:
the owner always sees their own job, hidden or not. The two share policies of
Part 2 carry `and not hidden` too — **Owner's call (question 1)**; dropping
those two tokens is the whole alternative.

### The views

Both views add `hidden` to their explicit column lists, so `/industry` can draw
the state and the menu can offer the inverse. A recipient never sees the
column true: every row a non-owner is granted has `hidden = false` by the
policies. The views are dropped and recreated (migration `20261008005932`
records why `create or replace` cannot be used on them).

### Unhide

The same menu, inverted: "Make this job Visible" writes `hidden = false`. The
job is granted again on the next request — the co-tenant default resumes if the
tenancy window is still open, and any share covering the scope carries it
again. No history of toggles is kept; `hidden_by` on a corp job is the only
trace, and it is never displayed.

### What hidden does _not_ do

- It does not hide the job from the owner, from the owner's corpmates (for a
  corp job — they are owners), from GraphQL/MCP/Links running as the owner, or
  from the Sheets endpoints.
- It does not touch `structure_tenant`: tenancy and its 30-day window are
  about the owner being at the structure, not about which rows are shown.
- It does not stop the extract: the row keeps versioning; `hidden` rides
  along.
- It does not reach the time-travel RPCs' residual: `character_industry_jobs()`
  and `corp_industry_jobs()` run on invoker rights over the `_over_time` tables,
  which `authenticated` may still read directly with `cost` intact (phase 13's
  known residual). The widening policies are on those tables, so a hidden job
  _is_ excluded from a direct read too — the residual is `cost` on visible
  rows, unchanged by this phase. Closing it belongs to a `cost`-masking change
  in those two functions, listed under Non-goals.

## Part 2 — share rows over a whole scope

Two tables, because the two owner types split the way they do for assets: an
account holding both corp jobs and character jobs can share either. A share
has **no subject column**. Its subject is every current job of the scope, and
a policy-based grant covers rows that do not exist yet without anyone doing
anything — that is what "future" means here. "Past" is every row the current
views hold, which since the SCD-2 rule for jobs keeps terminal rows
`is_current` is every job the extract ever saw finish. History versions never
cross (`is_current` on every policy).

### `corp_industry_job_share` — grantor is the corporation

```sql
create table public.corp_industry_job_share (
  id uuid primary key default gen_random_uuid(),
  -- Grantor: the corporation whose jobs are shared. One row per corporation.
  corporation_id bigint not null unique,
  -- The member the share is made on behalf of: whoever last wrote the row
  -- (the insert/update policies pin it to one of the caller's own characters
  -- in the corporation). The share stops matching once they leave the corp
  -- (corp_share_author_active()); a member re-saving revives it as theirs.
  -- A registration, never a user_id. Nullable, on delete set null.
  created_by uuid references public.registration (id) on delete set null,
  corporation_ids bigint[] not null default '{}',
  alliance_ids    bigint[] not null default '{}',
  secret text,
  created_at timestamptz not null default now()
);
alter table public.corp_industry_job_share enable row level security;
```

Policies are `corp_asset_share`'s verbatim, minus `item_id`: members read,
create, update and delete rows of their corporations
(`corporation_id in (select my_corporation_ids())`), every write pins
`created_by` to a registration of the caller's in that corporation, and the
load-bearing audience-read policy is

```sql
create policy "Audience reads corp industry job shares aimed at them"
  on public.corp_industry_job_share for select to anon, authenticated
  using (
    public.share_audience_matches(corporation_ids, alliance_ids, secret)
    and public.corp_share_author_active(corporation_id, created_by)
  );
```

Grants as phase 01: `select` to `anon`; `select, insert, update, delete` to
`authenticated`; `all` to `service_role`.

**The author gate applies.** The same reasoning as phase 14: the share is a
member's act on the corporation's behalf, and a member who has left should
not keep the corporation's job list open. Who may grant is **Owner's call
(question 2)**; the table is written so that swapping member-manage for the
director predicate changes four policy bodies and nothing else.

### `character_industry_job_share` — grantor is the account, anchored on a registration

```sql
create table public.character_industry_job_share (
  id uuid primary key default gen_random_uuid(),
  -- Anchor: one registration of the sharing account — the main when the row
  -- is created, else whichever one already holds it (phase 15's placeGrantor
  -- rule), so a re-save updates the same row. The share reaches EVERY
  -- registration of the anchor's account (job_sharing_registrations() below).
  -- A registration, never a user_id: the audience reads this row, and a
  -- registration uuid names only the public character it already names on
  -- every job row.
  registration_id uuid not null unique references public.registration (id) on delete cascade,
  corporation_ids bigint[] not null default '{}',
  alliance_ids    bigint[] not null default '{}',
  secret text,
  -- Present every job's owner as the account's main on the pages and the
  -- card (presentedOwner.ts). The data layer is unaffected.
  show_as_main boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.character_industry_job_share enable row level security;
```

`unique (registration_id)` plus the writer's anchor rule give one row per
account in practice; two rows (two anchors) would both match and both expand
to the same account, so nothing breaks if the rule is ever bypassed. The
owner policies are `character_asset_share`'s (read/insert/update/delete own,
keyed on the registration's `user_id`, repeated on `with check`); the
audience-read policy is `share_audience_matches(...)` verbatim, `to anon,
authenticated`.

**Why anchored on a registration and not `user_id`-keyed like `bpo_share`.**
Both work. `bpo_share` and `link` carry `user_id` on a row the audience can
read, which the README invariant tolerates for those two because their
pages already pool the account. Phase 15 is the more recent precedent and
keeps `user_id` off every audience-readable row; the expansion to the
account happens inside one definer. Follow phase 15.

### The expansion: one more argument-free SECURITY DEFINER

A policy on `character_industry_job_over_time` must answer "is this row's
registration one of an account that shares jobs with me", and `registration`
is RLS-hidden from the caller. So, the `asset_sharing_registration_ids()` /
`shared_place_pairs()` shape:

```sql
create or replace function public.job_sharing_registrations()
returns table (share_id uuid, registration_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select distinct s.id, r.id
  from public.character_industry_job_share s
  join public.registration anchor on anchor.id = s.registration_id
  join public.registration r on r.user_id = anchor.user_id
  -- Only registrations that hold a visible current job: see "What a share
  -- recipient can and cannot learn" for why this join is load-bearing.
  join public.character_industry_job_over_time j
    on j.registration_id = r.id and j.is_current and not j.hidden
  where public.share_audience_matches(s.corporation_ids, s.alliance_ids, s.secret);
$$;
revoke execute on function public.job_sharing_registrations() from public;
grant execute on function public.job_sharing_registrations() to anon, authenticated;
```

Safe for the reasons the others are: argument-free and `stable`, so the
planner evaluates it once into a hashed subplan; `share_audience_matches()`
resolves `auth.uid()` to the **caller** inside the definer; pinned
`search_path`; revoked from `public`; and every value it returns is a
registration uuid the policy is about to grant rows for — the grant itself,
not a window past it. It returns the pair rather than the bare set so a
recipient page can group a share's registrations under its share (phase 15's
`shared_place_pairs()` returns pairs for the same reason). It never returns
`user_id`.

**Rejected:** denormalising the account's registration ids onto the share row
(`registration_ids uuid[]`) — avoids the definer, but a character added later
is not covered until the owner re-saves, which breaks "future" for the one
subject where it matters most.

### The widening policies

```sql
create policy "Audience reads shared industry jobs"
  on public.character_industry_job_over_time for select to anon, authenticated
  using (
    is_current
    and not hidden
    and registration_id in (select j.registration_id from public.job_sharing_registrations() j)
  );

create policy "Audience reads shared corp industry jobs"
  on public.corp_industry_job_over_time for select to anon, authenticated
  using (
    is_current
    and not hidden
    and corporation_id in (
      select s.corporation_id from public.corp_industry_job_share s
      -- The share table's own audience policy has already applied
      -- share_audience_matches() and the author gate; what is left is the
      -- rows aimed at the caller.
    )
  );

grant select on public.character_industry_job_over_time to anon;
grant select on public.corp_industry_job_over_time       to anon;
grant select on public.character_industry_job            to anon;
grant select on public.corp_industry_job                 to anon;
```

Neither policy reads a job table, so neither recurses. Both are the hashed
subplan shape of `my_tenant_structure_ids()`, evaluated once per statement.
The corp policy needs no definer at all: the share row is readable by its
audience, and `corporation_id` is right on it. `anon` gets the grants because
a fully public share is readable signed-out, as every other public share in
the layer is; RLS still grants `anon` nothing but rows a public share covers
(the owner and tenant policies are `to authenticated`, and `my_*_ids()` are
empty for `anon`).

**Performance, to measure before merging PR 3.** The `/structure` page drains
every visible current job; the two tenant policies already cost one hashed
subplan each there. These add two more of the same shape, plus `not hidden`
(a column read). `explain analyze` a member's `select * from
character_industry_job` and the `/structure` drain, with and without shares
in the system, and keep the numbers in this doc. There is no climb and no
per-row function call, so there is nothing like phase 15's gate to add; if a
number surprises, the share tables are tiny and the fix is an index on the
job tables' owner columns, which already exist.

### Composition, stated once

A current job row is visible to a caller when **any** of these holds:

| Policy                | Predicate                                                                   | `cost` in the view |
| --------------------- | --------------------------------------------------------------------------- | ------------------ |
| owner                 | the row's registration is the caller's / the corporation is one of theirs   | real               |
| co-tenant (phase 13)  | `not hidden` and the job's structure is in `my_tenant_structure_ids()`      | null               |
| share (this phase)    | `not hidden` and the row's scope has a share whose audience the caller is   | null               |

Policies are permissive, so these OR. `hidden` is tested by the two widening
paths and never by the owner path. A co-tenant who is also in a share's
audience is granted twice and sees the row once. **A recipient never sees
`cost`**, whichever path granted the row — the view's `case` keys on
ownership, not on the policy that matched. **Owner's call (question 5).**

### What a share recipient can and cannot learn

A recipient of either share, through the view: `job_id`, activity, blueprint
type and item id, product type, runs, licensed runs, probability, status,
dates, duration, `installer_id` (an EVE character id), the job's
`station_id`/`facility_id` (**Owner's call, question 3**), the blueprint and
output location item ids (container ids they cannot read into), and the
owner column: `registration_id` or `corporation_id`.

A recipient of a **character-jobs share** additionally learns that the
registrations whose jobs they see belong to one account — alt correlation,
the one thing `design.md` protects. This is the deliberate, opt-in exception
`bpo_share` already made and phase 15's account-wide place share made again:
the owner chose to publish the account's jobs as one list, and that list is
the correlation. It is bounded: no `user_id`, no email, and no character of
the account that has no job. That last point needs one line of care, because
`job_sharing_registrations()` is executable by the recipient directly, not
only from inside the policy: as sketched above it would list every
registration of the sharing account, jobs or not. So the definer joins to
`character_industry_job_over_time` and returns a registration only while it
holds a current, non-hidden job — then a direct call discloses exactly the
set the rows themselves disclose, and nothing more. Written into PR 2.
`show_as_main` hides which alt ran which job on the pages; it hides nothing
from GraphQL/MCP, which return the row.

Nothing else of the account's is reached: assets, wallets, blueprints,
history versions, hidden jobs, the share rows of other subjects.

A recipient of a **corp-jobs share** learns the corporation's jobs and the
installers' EVE ids — which corpmates and alliance-mates could already read
in the client with the right role. No account of any member is correlated:
`installer_id` is an EVE id, and `created_by` is never displayed.

## UI

### `/industry` — the per-row control

Off to the right of each row of the job list, a new last column holding an
**ellipsis button** (`…`, `aria-label="Job options"`). It opens a small
popover menu — a native `<dialog>` positioned by the button, or the
`popover` attribute, no library — with one item:

- **Make this job Hidden** (or **Make this job Visible** when `hidden`), and
  beside it the description text, word for word what the default means:

  > Jobs are visible to all other users who have run a job in that structure
  > within 30 days of that job, because both of you are affecting each
  > other's cost indexes. A hidden job is seen only by you.

  The last sentence changes to "A hidden job is seen only by you — not by
  co-tenants, and not through any share" under the recommended answer to
  question 1.

A hidden row carries a small `hidden` tag in that column so the owner can see
the state at a glance, and the chart is unaffected (it is the owner's own
view). Jobs at NPC stations show the menu too — the flag is meaningful once a
share exists, and the text is the same. The item is a server action
(`setJobHidden(jobId, hidden)` in `src/app/industry/hiddenActions.ts`, cookie
client, `update … set hidden where job_id = …` on whichever of the two tables
the row came from; RLS and the column grant are the guards). For a corp job
the action also sets `hidden_by` to the caller's registration in that
corporation.

### `/industry` — the Share button

The page header gains one **Share** button (the `AssetShareDialog` pattern:
one button, the dialog chooses the writer). It opens the generic
`ShareDialog` with a chooser between **"Your characters' jobs"** and each
corporation the caller has a character in — the same owner split the
page's `OwnerSelect` already draws — shown only when more than one of those
exists, as phase 15's place dialog does. Each choice is one share row:

| Choice               | Table                          | Hint line                                                                                                        | Extras                                                           |
| -------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Your characters' jobs | `character_industry_job_share` | "Every industry job of every character on this account, finished or running, live — hidden jobs excepted." | `show_as_main` checkbox (the existing `mainName` prop)           |
| `<Corporation>`      | `corp_industry_job_share`      | "Every industry job run as `<Corporation>`, finished or running, live — hidden jobs excepted. Shared on your behalf; it stops when you leave the corporation." | none                                                             |

Writers: `saveCharacterJobShare`/`revokeCharacterJobShare` (anchor rule =
phase 15's `placeGrantor`, grantor guard = one of the caller's registrations)
and `saveCorpJobShare`/`revokeCorpJobShare` (guard = a corp the caller has a
character in; every write stamps `created_by`), in
`src/app/industry/shareActions.ts`, on the cookie-session client like every
share writer. `urlPath` is the grantor page below. The pure chooser
(`jobShareSubject.ts`: which grantors the caller may pick, and the hint per
kind) is tested.

### The grantor pages, and `?share=`

`/industry` is "our jobs" and stays so (its own comment says the `/structure`
tiles are where the others belong). Shared jobs get a page per grantor:

- `/industry/character/[characterId]` — the **anchor's EVE character id**
  (the fitting route's convention; `character_directory` maps it back to the
  anchor registration, and from there the share row), drawing the whole
  account's character jobs.
- `/industry/corporation/[corporationId]` — the corporation's jobs.

Each page renders the same `IndustryView` (chart, window, list) over the
rows the caller may see for that grantor, with three differences: the owner
filter lists the grantor's owners (each character through
`character_directory`, or the one corporation); the install fee is unknown
(`cost` is null), so lift is drawn without it and the caption reads "fees
unknown on shared jobs"; and there is no ellipsis column. Under
`show_as_main` the owner column is the main for every row, rows carry
`PRESENTED_OWNER_ID` (`presentedOwner.ts`, reused), and the page sends no
registration uuid.

Three ways in, one page:

1. **Signed-in audience member** (corporation, alliance or public share):
   the page reads the views as the caller; RLS does the rest. The grantor's
   registration set comes from `job_sharing_registrations()` filtered to the
   share, or from the corp share row.
2. **Signed link** `?share=<signature>`: `src/app/industry/access.ts`
   `resolveJobShare(param, grantor)` reads the one candidate row on the
   service role (the anchor's share by `character_directory`, or the
   corporation's), verifies the signature (`verifyShareToken`, `TOKEN_SALT`;
   legacy `<id>.<sig>` narrows), and returns a scope: the account's
   registration ids or the corporation id, plus `show_as_main`. The page then
   reads with a service client **scoped to that set, `is_current`, `not
hidden`, and `cost` dropped before render** — the asset share page's
   discipline. Signed-out allowed. The corp path also checks
   `corp_share_author_active()` through the directory, so a link outlives its
   author exactly as long as the RLS path does.
3. **Fully public, signed out**: the same resolver with no signature, taking
   the row only when it names no one (`isPublic`), as `/bpos` and the phase 12
   structure path do.

The list page is a `noindex` page like the other share pages; no card image
in this phase (Non-goals).

### "Shared with you" on `/industry`

Below the header, a one-line strip — "Shared with you: Sir Cuddles's
characters · Goonwaffe" — linking to the grantor pages, drawn from the share
rows the caller's RLS shows minus their own (the `sharedWithMe` discipline):
character shares named by the anchor's directory name (or "a private owner"
under `show_as_main` with no main set), corp shares by the corporation. Empty
means the strip is not drawn.

## GraphQL and MCP

Opt-in, like `include_shared` everywhere else; session mode only for
GraphQL.

- **GraphQL** `industryJobs(…, includeShared: Boolean = false)`: widens the
  leak-guard `.in()` on the character side with
  `job_sharing_registrations()`'s registration ids and on the corp side with
  the grantor corporations of readable `corp_industry_job_share` rows, and
  lets RLS decide; an owner filter still narrows only the caller's own owners
  (phase 04's rule, verbatim). Rows carry `shared: Boolean!` and `cost` is
  null on them. `sharedWithMe` gains an optional `subject: ASSET |
INDUSTRY_JOBS` on `ShareGrant` (default `ASSET`, so existing queries read
  unchanged) and lists job shares with `ownerType` `character` (the anchor)
  or `corporation`, no `itemId`.
- **MCP** `list_industry_jobs(include_shared?: boolean)`: default false; live
  only — refused with `as_of`, as the asset tools refuse it, because the
  time-travel RPCs take owner lists and a recipient has no business handing
  them a grantor's. With it, the two live reads drop their owner filter in
  favour of own ∪ grantors, rows report `shared: true` and `owner` resolves
  through `character_directory`/`corporation`. `annotations` unchanged
  (`readOnlyHint: true`).
- **Links** need nothing: a Link runs under its creator's context, and a
  creator who is a recipient gets shared rows only if their query asks for
  `includeShared`.

## PR plan

| PR  | Contents                                                                                                                                                                                                                                                                                                                                      | Depends on | Blast radius                                                                                                                       |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `hidden` (+ `hidden_by`) columns, the two triggers, column grants, update policies, `and not hidden` on both tenant policies, views recreated with `hidden`. `/industry` ellipsis menu + `hiddenActions.ts`. `test/sql/industry_job_hidden.sql`.                                                                                                | —          | Default `false`: nothing changes until someone hides a job. The view recreate is the one thing to rehearse (migration `20261008005932`'s note). |
| 2   | `corp_industry_job_share`, `character_industry_job_share`, `job_sharing_registrations()`, owner + audience policies, grants. Nothing reads them. `test/sql/industry_job_share.sql` (share-table half).                                                                                                                                         | 1          | None. Pure additive schema.                                                                                                        |
| 3   | The two widening policies, `anon` grants on the tables and views. `explain analyze` numbers into this doc. `test/sql/industry_job_share.sql` (policy half + recursion smoke as `authenticated`).                                                                                                                                              | 2          | Rows cross only where a share row exists; none do yet.                                                                             |
| 4   | Share button + chooser on `/industry`, `shareActions.ts`, grantor pages, `access.ts` + `?share=` + public path, "Shared with you" strip, `show_as_main` presentation. Unit tests for `jobShareSubject.ts`.                                                                                                                                      | 3          | UI on a proven substrate.                                                                                                          |
| 5   | GraphQL `includeShared` on `industryJobs`, `sharedWithMe.subject`; MCP `include_shared`.                                                                                                                                                                                                                                                       | 3          | Opt-in flags; nothing changes for callers who do not pass them.                                                                    |

Each migration takes its timestamp from the clock (`pnpm run db:new`), each
edits `schema.sql` too, and PR 1's doc update records the `hidden` column
beside the SCD-2 notes in CLAUDE.md.

## Verification

- **`test/sql/industry_job_hidden.sql`** (the `tenant_industry_jobs.sql`
  harness): A and B tenants at one structure; B reads A's job; A sets
  `hidden` → B reads nothing, A still reads it; A's reconcile closes and
  inserts a new version → the new row is hidden (trigger); A updates
  `hidden = false` → B reads it again; B's `update … set hidden` on A's row
  touches zero rows; A's `update … set runs = 1` is a permission error (column
  grant); corp: a member hides, a second member on another account unhides
  with `hidden_by` moving to them, a non-member touches nothing; `hidden_by`
  of another account's registration is refused by `with check`.
- **`test/sql/industry_job_share.sql`**: account A (main + alt, jobs on both,
  one hidden) and corporation C (two members on two accounts). Assert: A's
  share to corp X → member B of X reads both characters' current rows with
  `cost` null, not the hidden job, not any history row, nothing from A's
  asset or blueprint tables; `job_sharing_registrations()` as B returns only
  A's registrations with a current job; revoke → B reads nothing on the next
  statement; a link-only row matches nobody under RLS; a fully public row is
  read by `anon`; C's share by member M → an alliance-mate reads C's rows,
  loses them when M's directory row leaves C, regains them when the other
  member re-saves; a stranger reads nothing throughout; a policy-level smoke
  as `authenticated` proving no recursion on either table.
- **The two-account leak test** (README): B signed in sees exactly A's shared
  jobs on `/industry/character/<A's main>` and in `industryJobs(includeShared:
true)`, and nothing on `/industry` itself or in `assets(includeShared:)`;
  anon sees a public share signed-out; a hidden job is absent on every
  surface; revoking closes access on the next request.
- `pnpm run lint`, `pnpm test`, `pnpm run build`, `pnpm run test:sql` against a
  throwaway database, every PR.

## Non-goals

- **No per-structure or per-job share subject.** The share covers the scope;
  the hidden flag is the per-job knob. Phase 13's `(character, structure)`
  grant is not revived.
- **No `totals` pool, no `structure_eiv_daily`.** Phase 13's pooled
  throughput stays unbuilt; nobody has asked for the pooled number since the
  co-tenant view shipped.
- **No card image** for the grantor pages in this phase; a chat unfurl of a
  job list is a follow-up if anyone shares one into Discord.
- **No change to the `_over_time` `cost` residual** from phase 13 beyond
  noting that hidden rows are now excluded from direct reads too. Masking
  `cost` on non-own rows inside `character_industry_jobs()` /
  `corp_industry_jobs()` is the fix, and belongs with the time-travel RPCs.
- **No share of `cost`, ever** in this phase (question 5).
- **No tenants audience on job shares.** Phase 12's `tenants` flag is a
  structure share's audience; for jobs, co-tenancy is already the default
  grant, so a `tenants` flag would be redundant with phase 13.
- **No notification to co-tenants** when a job is hidden — that is the
  requirement.
