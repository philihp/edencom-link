# Phase 16: industry job shares — a quiet per-job opt-out, and share rows over a whole scope

**Status: 🚧 PR 1 of 5 built** — the hidden flag and its `/industry` menu
(migration `20261016004245`, `test/sql/industry_job_hidden.sql`). PRs 2–5 are
planned. Five PRs; each one leaves production working. Supersedes the opt-in grant and the `jobs` level of
[13-industry-job-share.md](13-industry-job-share.md) (its `totals` pool stays
unbuilt and is not planned here).

## Decided by the owner (2026-10-14)

- **Hidden is its own table**, pointing back at the job, applied _after_ the
  grants: whatever the co-tenant policy and the share policies would show, a
  row in `industry_job_hidden` takes back. It is the exception for the rare
  sensitive build — a faction titan is a high-value target and intel on it is
  a security risk — and it must be quiet: unless someone goes around asking
  why totals don't add up, nobody knows the job was there.
- **Hidden excludes the job from shares** as well as from co-tenants. One
  flag, one meaning.
- **A shared character job is presented as the sharer's main character; a
  shared corp job as the corporation.** The same presentation applies to
  what co-tenants see today, so the Structures page's Characters tab groups
  total EIV by main character and by corporation, not by the character who
  installed each job.

## Open questions for the owner

1. **Who may hide a corp job, and who may create a corp jobs share?**
   Recommended **any member of the corporation** (phase 14's rule: whoever
   can read the corp's rows can share them), with `corp_job_access (job =
'corp-industry-jobs')` named as the ready-made Factory Manager proof to swap
   in if that should be directors only (phase 12's rule). For the hide alone,
   installer-only is also possible (`installer_id` is on the row).
2. **Does a recipient see where a job runs?** Recommended **yes**, as
   co-tenants do today: `station_id`/`facility_id` stay on the row. The asset
   layer hides a root's place from recipients (phase 11); a job list without
   its structures is a different product, and the owner can hide any job
   whose location is the sensitive part. Masking it for non-tenant
   recipients would be one more `case` in the two views, like `cost`.
3. **Presenting co-tenants' jobs under their main is a new disclosure.**
   Today the Characters tab is deliberately one row per character, because an
   account can hold several people's characters and `registration.is_main` is
   one main per account (`installers.ts`). Grouping by main tells a co-tenant
   which characters share an account — the correlation `design.md` protects —
   for every account building at the structure, not only accounts that chose
   to share. This document follows the decision above; the alternative that
   keeps today's posture is to present co-tenant rows per character and only
   _share_ recipients' rows as the main.
4. **`cost` stays masked for every recipient.** Not offered as an option on
   the share: `cost` inverts to the structure's tax rate, and a public share
   would publish it. Listed so the owner can overrule.

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

A current job row is visible to its owner; to a co-tenant of the structure it
runs at; and to the audience of a share covering its scope — and then
`industry_job_hidden` takes back any row it names, from the two widened
paths and never from the owner. Shares are two sibling tables on the
Revision 3 audience shape: `corp_industry_job_share`, keyed on the
corporation with phase 14's `created_by` author gate, and
`character_industry_job_share`, anchored on one registration and reaching
the whole account through one argument-free SECURITY DEFINER of the
`asset_sharing_registration_ids()` shape. A share has no subject column —
its subject is every current job of the scope, now and later, which is what a
policy-based grant gives for free. The two views do the presentation: a
non-own character row's owner reads as the sharer's **main**, a corp row's as
the corporation, and `cost` is null on both — so every reader (pages, the
Characters tab, GraphQL, MCP, Links) sees the same thing without doing
anything.

## Part 1 — the quiet opt-out: `industry_job_hidden`

### The table

```sql
create table public.industry_job_hidden (
  -- The job. ESI job ids are global, and a corp job installed by one of our
  -- own characters appears in BOTH job tables under the same job_id — one
  -- row here hides both, which is the intended reading.
  job_id bigint primary key,
  -- Exactly one owner key: the registration whose personal job it is, or the
  -- corporation the job was run for (structure_tenant's shape).
  registration_id uuid references public.registration (id) on delete cascade,
  corporation_id  bigint,
  -- For a corp job: the member who hid it, one of the caller's own characters
  -- in that corporation (the with check below). Audit only, never shown. A
  -- hide persists when they leave — hidden is a restriction, not a grant, so
  -- the safe direction is to keep it.
  hidden_by uuid references public.registration (id) on delete set null,
  hidden_at timestamptz not null default now(),
  owner_key text generated always as (coalesce(registration_id::text, 'corp:' || corporation_id::text)) stored,
  check ((registration_id is null) <> (corporation_id is null))
);
create index industry_job_hidden_owner_key_idx on public.industry_job_hidden (owner_key);
alter table public.industry_job_hidden enable row level security;
```

Keyed on the job's identity rather than on a version row, so the extract's
versioning never touches it: a job that goes `active → ready` opens a new
version and is still named here. No carry-forward, no trigger, nothing for
`industryJobReconcile.js` to know. The table is short — hiding is the
exception — and never swept: a hidden job that ages out of ESI stays hidden
for as long as its terminal row stays `is_current`.

### Owner-managed under RLS

Own rows only, with the write proving the caller owns the job it names: the
job table's **owner** policy answers that, since a row the caller does not own
is not readable by the owner predicate. (The read goes through the job table's
SELECT policies, one of which calls the definer below — which reads this table
_directly_, never through its policies, so there is no cycle.)

```sql
create policy "Users read own hidden jobs"
  on public.industry_job_hidden for select to authenticated
  using (
    registration_id in (select id from public.registration where user_id = (select auth.uid()))
    or corporation_id in (select public.my_corporation_ids())
  );

create policy "Users hide own industry jobs"
  on public.industry_job_hidden for insert to authenticated
  with check (
    (registration_id in (select id from public.registration where user_id = (select auth.uid()))
     and hidden_by is null
     and exists (
       select 1 from public.character_industry_job_over_time j
       where j.job_id = industry_job_hidden.job_id
         and j.registration_id = industry_job_hidden.registration_id
     ))
    or
    (corporation_id in (select public.my_corporation_ids())
     and hidden_by in (
       select r.id from public.registration r
       where r.user_id = (select auth.uid()) and r.corporation_id = industry_job_hidden.corporation_id
     )
     and exists (
       select 1 from public.corp_industry_job_over_time j
       where j.job_id = industry_job_hidden.job_id
         and j.corporation_id = industry_job_hidden.corporation_id
     ))
  );

create policy "Users unhide own industry jobs"
  on public.industry_job_hidden for delete to authenticated
  using (
    registration_id in (select id from public.registration where user_id = (select auth.uid()))
    or corporation_id in (select public.my_corporation_ids())
  );

grant select, insert, delete on public.industry_job_hidden to authenticated;
grant all                    on public.industry_job_hidden to service_role;
```

No update policy: hide is an insert, unhide is a delete. As built, a
character job's hide must leave `hidden_by` null — the column is a corp job's
audit, and without the test a caller could stamp any registration uuid on
their own row. A corp job may be
hidden by any member and unhidden by any member — **Owner's call (question
1)**; the installer-only alternative is `installer_id in (select character_id
from registration where user_id = auth.uid())` in place of the membership
test, and the director alternative is phase 12's `corp_job_access` predicate
with `job = 'corp-industry-jobs'`.

### How it enters the policies: one more argument-free SECURITY DEFINER

The rows a co-tenant must _not_ see are the owner's rows of this table, which
the co-tenant's RLS cannot read. A world-readable table of hidden job ids
would read them — and would tell a co-tenant exactly what "quietly" forbids:
that the job they were watching was hidden rather than delivered. So the set
is read through a definer, the `my_tenant_structure_ids()` /
`corp_shared_item_ids()` shape:

```sql
create or replace function public.hidden_industry_job_ids()
returns setof bigint
language sql
stable
security definer
set search_path = public
as $$
  select job_id from public.industry_job_hidden;
$$;
revoke execute on function public.hidden_industry_job_ids() from public;
grant execute on function public.hidden_industry_job_ids() to anon, authenticated;
```

Argument-free and `stable`, so the planner evaluates it once per statement
into a hashed subplan — no per-row probe, no scan of a job table, and no
recursion (it reads only `industry_job_hidden`). It returns bare job ids and
nothing else: no owner, no structure, no state. **What that discloses:** a
caller who calls it directly reads every hidden job id in the system. A job
id is a number with no meaning to anyone who never saw the job; someone who
_had_ seen the job before it was hidden could confirm its id is in the set.
That is the one residue of "quietly", and the owner's reading of the
requirement — nobody learns unless they go looking for why totals don't add
up — accepts it. Narrowing the set to ids among rows the caller would
otherwise be granted would mean the definer re-deriving tenancy and share
audiences, and buys only that residue.

The two shipped tenant policies gain one conjunct, as do the two share
policies of Part 2:

```sql
create policy "Tenants read industry jobs at shared structures"
  on public.character_industry_job_over_time for select to authenticated
  using (
    is_current
    and coalesce(station_id, facility_id) in (select public.my_tenant_structure_ids())
    and job_id not in (select public.hidden_industry_job_ids())
  );
```

(`corp_industry_job_over_time` the same.) The owner policies do not test it:
the owner always sees their own job, hidden or not.

### The signed-link path applies it too

A `?share=` page reads with the service role, which bypasses every policy.
The resolver's scope therefore carries the hidden set explicitly, and the page
filters it out before render — the same discipline the asset share page keeps
for `cost`. `test/sql` cannot prove that; the two-account leak test does.

### Unhide

The same menu, inverted: "Make this job Visible" deletes the row. The job is
granted again on the next request — the co-tenant default resumes if the
tenancy window is still open, and any share covering the scope carries it
again. No history of toggles is kept.

### What hidden does _not_ do

- It does not hide the job from the owner, from the owner's corpmates (for a
  corp job — they are owners), from GraphQL/MCP/Links running as the owner, or
  from the Sheets endpoints.
- It does not touch `structure_tenant`: tenancy and its 30-day window are
  about the owner being at the structure, not about which rows are shown. A
  hidden job still moves the system's cost index, which is the reason the
  default exists.
- It does not announce itself. The Structures page's totals, Characters tab
  and co-tenant EIV simply omit the job; nothing is drawn in its place.
- It does not reach the time-travel RPCs' residual: `character_industry_jobs()`
  and `corp_industry_jobs()` run on invoker rights over the `_over_time`
  tables, which `authenticated` may still read directly with `cost` intact
  (phase 13's known residual). The widening policies are on those tables, so
  a hidden job _is_ excluded from a direct read too — the residual is `cost`
  on visible rows, unchanged by this phase (Non-goals).

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
(question 1)**; the table is written so that swapping member-manage for the
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
  created_at timestamptz not null default now()
);
alter table public.character_industry_job_share enable row level security;
```

No `show_as_main` column: presenting the main is the rule for every shared
character job (below), not a choice. `unique (registration_id)` plus the
writer's anchor rule give one row per account in practice; two rows (two
anchors) would both match and both expand to the same account, so nothing
breaks if the rule is ever bypassed. The owner policies are
`character_asset_share`'s (read/insert/update/delete own, keyed on the
registration's `user_id`, repeated on `with check`); the audience-read policy
is `share_audience_matches(...)` verbatim, `to anon, authenticated`.

**Why anchored on a registration and not `user_id`-keyed like `bpo_share`.**
Both work. `bpo_share` and `link` carry `user_id` on a row the audience can
read, which the README invariant tolerates for those two because their pages
already pool the account. Phase 15 is the more recent precedent and keeps
`user_id` off every audience-readable row; the expansion to the account
happens inside one definer. Follow phase 15.

### The expansion: `job_sharing_registrations()`

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
  -- Only registrations that hold a visible current job, so a direct call
  -- discloses exactly the set the rows themselves disclose (see "What a
  -- share recipient can and cannot learn").
  join public.character_industry_job_over_time j
    on j.registration_id = r.id and j.is_current
  where j.job_id not in (select public.hidden_industry_job_ids())
    and public.share_audience_matches(s.corporation_ids, s.alliance_ids, s.secret);
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
    and registration_id in (select j.registration_id from public.job_sharing_registrations() j)
    and job_id not in (select public.hidden_industry_job_ids())
  );

create policy "Audience reads shared corp industry jobs"
  on public.corp_industry_job_over_time for select to anon, authenticated
  using (
    is_current
    -- The share table's own audience policy has already applied
    -- share_audience_matches() and the author gate; what is left is the
    -- rows aimed at the caller.
    and corporation_id in (select s.corporation_id from public.corp_industry_job_share s)
    and job_id not in (select public.hidden_industry_job_ids())
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
subplan each there. These add three more of the same shape (two share sets
and the hidden set). `explain analyze` a member's `select * from
character_industry_job` and the `/structure` drain, with and without shares
in the system, and keep the numbers in this doc. There is no climb and no
per-row function call, so there is nothing like phase 15's gate to add.

### Composition, stated once

A current job row is visible to a caller when **any** of these holds:

| Policy               | Predicate                                                                                  | Owner shown in the view | `cost` in the view |
| -------------------- | ------------------------------------------------------------------------------------------ | ----------------------- | ------------------ |
| owner                | the row's registration is the caller's / the corporation is one of theirs                  | the character / the corp | real               |
| co-tenant (phase 13) | the job's structure is in `my_tenant_structure_ids()`, and the job is not hidden           | the main / the corp      | null               |
| share (this phase)   | the row's scope has a share whose audience the caller is, and the job is not hidden        | the main / the corp      | null               |

Policies are permissive, so these OR; `hidden` takes back from the two
widened paths after the grants and never from the owner path. A co-tenant who
is also in a share's audience is granted twice and sees the row once. **A
recipient never sees `cost`**, whichever path granted the row — the view's
`case` keys on ownership, not on the policy that matched. **Owner's call
(question 4).**

## Presentation: the main, and the corporation

A shared character job is shown as the sharer's **main character's**; a
shared corp job as the **corporation's**. Corp rows already are: the view's
owner column is `corporation_id`, and the name comes from the `corporation`
directory. Character rows need a mapping from the installing registration to
its account's main — and that mapping is exactly the alt correlation the
layer keeps private, so it must be computed only for registrations the caller
is granted rows for, and never be callable more widely.

### `visible_job_owners()` — the fourth definer of this phase's shape

```sql
create or replace function public.visible_job_owners()
returns table (registration_id uuid, main_registration_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  with granted as (
    -- Registrations whose current, non-hidden jobs the caller may see
    -- through a widened path: co-tenancy, or a character share.
    select distinct j.registration_id
    from public.character_industry_job_over_time j
    where j.is_current
      and j.job_id not in (select public.hidden_industry_job_ids())
      and (
        coalesce(j.station_id, j.facility_id) in (select public.my_tenant_structure_ids())
        or j.registration_id in (select s.registration_id from public.job_sharing_registrations() s)
      )
  )
  select g.registration_id, m.id
  from granted g
  join public.registration r on r.id = g.registration_id
  left join public.registration m on m.user_id = r.user_id and m.is_main
  where g.registration_id not in (
    select id from public.registration where user_id = (select auth.uid())
  );
$$;
revoke execute on function public.visible_job_owners() from public;
grant execute on function public.visible_job_owners() to anon, authenticated;
```

Argument-free, `stable`, one hashed subplan. It reads the job table directly
(a definer does not re-enter the table's policies, which is the sanctioned
reason it exists) and `registration` for the main. It returns, for each
registration the caller is already granted rows for, the main's registration
id — or null when the account has no main. **Disclosure:** exactly the
grouping the pages show. A registration with no visible job never appears.

### The views present it

Both views are recreated (migration `20261008005932` records why `create or
replace` cannot be used on them). The character view's `registration_id`
becomes the **presented owner**:

```sql
create view public.character_industry_job with (security_invoker = on) as
  select
    j.id, j.job_id,
    -- Own rows name their character. A widened row names the owner's main,
    -- or nothing when the account has no main: the holder stays hidden.
    (case
      when j.registration_id in (select r.id from public.registration r where r.user_id = (select auth.uid()))
      then j.registration_id
      else (select o.main_registration_id from public.visible_job_owners() o where o.registration_id = j.registration_id)
    end) as registration_id,
    (j.registration_id in (select r.id from public.registration r where r.user_id = (select auth.uid()))) as own,
    j.installer_id, j.facility_id, j.station_id, j.activity_id,
    j.blueprint_id, j.blueprint_type_id, j.blueprint_location_id, j.output_location_id,
    j.product_type_id, j.runs,
    (case when … own … then j.cost end)::numeric(20, 2) as cost,
    …
  from public.character_industry_job_over_time j
  where j.is_current;
```

`installer_id` (an EVE character id, which names the installing character as
surely as the registration does) is masked the same way: real on own rows,
the main's `character_id` (through `registration`, inside the same definer —
add it as a third column) on widened rows, null when no main. The corp view
gains the same `own` boolean and masks nothing else: its owner already is the
corporation, and `installer_id` on a widened corp row becomes null (a co-tenant
or recipient sees "the corporation built it", not which member).

Then nothing downstream has to know. The structure page's Characters tab
(`installers.ts`) groups personal jobs by `registration_id`, which now _is_
the main for every row that is not ours; it resolves the name through
`character_directory` as it does today, and **its "one row per character"
comment is rewritten** to say rows are one per main for co-tenants and one
per character for our own (**Owner's call, question 3**). A widened row with
no main (`registration_id` null) is one "Private owner" row. GraphQL
`industryJobs`, MCP `list_industry_jobs`, Links and the `/industry` grantor
pages read the same view and get the same answer. `presentedOwner.ts` is not
needed for jobs: the view does on the server what that module does in the
app for ships.

### What a share recipient can and cannot learn

Through the view: `job_id`, activity, blueprint type and item id, product
type, runs, licensed runs, probability, status, dates, duration, the job's
`station_id`/`facility_id` (**Owner's call, question 2**), the blueprint and
output location item ids (container ids they cannot read into), and the
owner: the sharer's **main** (name through `character_directory`), or the
corporation.

A recipient of a **character-jobs share** learns that one person — the main
— runs these jobs, and nothing about which alt installed which. That is
_less_ than the rows carry, and is the point of presenting the main: an
account-wide share would otherwise be the correlation `design.md` protects
(the `bpo_share` / phase 15 exception), and here the view collapses it to one
public name. Bounded: no `user_id`, no email, no character of the account
that has no visible job (`job_sharing_registrations()` and
`visible_job_owners()` both join to current, non-hidden rows, so a direct
call to either lists nothing the rows do not). The account's `_over_time`
tables are reachable only through the same policies, with the raw
`registration_id` on them — the phase 13 residual, noted again under
Non-goals. Nothing else of the account's is reached: assets, wallets,
blueprints, history versions, hidden jobs, the share rows of other subjects.

A recipient of a **corp-jobs share** learns the corporation's jobs — which
corpmates and alliance-mates could already read in the client with the right
role — and not who installed them. No account of any member is correlated;
`created_by` is never displayed.

## UI

### `/industry` — the per-row control

Off to the right of each row of the job list, a new last column holding an
**ellipsis button** (`…`, `aria-label="Job options"`). It opens a small
popover menu — a native `<dialog>` positioned by the button, or the
`popover` attribute, no library — with one item:

- **Make this job Hidden** (or **Make this job Visible** when hidden), and
  beside it the description text, word for word what the default means:

  > Jobs are visible to all other users who have run a job in that structure
  > within 30 days of that job, because both of you are affecting each
  > other's cost indexes. A hidden job is seen only by you — not by
  > co-tenants, and not through any share.

A hidden row carries a small `hidden` tag in that column so the owner can see
the state at a glance; the chart is unaffected (it is the owner's own view).
Jobs at NPC stations show the menu too — the flag is meaningful once a share
exists, and the text is the same. The item is a server action
(`setJobHidden(jobId, hidden)` in `src/app/industry/hiddenActions.ts`, cookie
client: insert or delete on `industry_job_hidden`, with the owner key from
the row the page already holds; RLS is the guard, and the insert policy's
`exists` on the job table is what proves ownership). For a corp job the
action also stamps `hidden_by` with the caller's registration in that
corporation. The page reads `industry_job_hidden` (own rows) once to draw the
tags.

### `/industry` — the Share button

The page header gains one **Share** button (the `AssetShareDialog` pattern:
one button, the dialog chooses the writer). It opens the generic
`ShareDialog` with a chooser between **"Your characters' jobs"** and each
corporation the caller has a character in — the same owner split the page's
`OwnerSelect` already draws — shown only when more than one of those exists,
as phase 15's place dialog does. Each choice is one share row:

| Choice                | Table                          | Hint line                                                                                                                                                                       |
| --------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Your characters' jobs | `character_industry_job_share` | "Every industry job of every character on this account, finished or running, live — hidden jobs excepted. They are shown as `<main>`'s." (or "…as a private owner's" with no main set) |
| `<Corporation>`       | `corp_industry_job_share`      | "Every industry job run as `<Corporation>`, finished or running, live — hidden jobs excepted. Shared on your behalf; it stops when you leave the corporation."                   |

No `showAsMain` checkbox on either. Writers: `saveCharacterJobShare` /
`revokeCharacterJobShare` (anchor rule = phase 15's `placeGrantor`, grantor
guard = one of the caller's registrations) and `saveCorpJobShare` /
`revokeCorpJobShare` (guard = a corp the caller has a character in; every
write stamps `created_by`), in `src/app/industry/shareActions.ts`, on the
cookie-session client like every share writer. `urlPath` is the grantor page
below. The pure chooser (`jobShareSubject.ts`: which grantors the caller may
pick, and the hint per kind) is tested.

### The grantor pages, and `?share=`

`/industry` is "our jobs" and stays so (its own comment says the `/structure`
tiles are where the others belong). Shared jobs get a page per grantor:

- `/industry/character/[characterId]` — the **anchor's EVE character id**
  (the fitting route's convention; `character_directory` maps it back to the
  anchor registration, and from there the share row), drawing the whole
  account's character jobs, every row owned by the main.
- `/industry/corporation/[corporationId]` — the corporation's jobs.

Each page renders the same `IndustryView` (chart, window, list) over the
rows the caller may see for that grantor, with three differences: the owner
filter is one entry (the main, or the corporation); the install fee is
unknown (`cost` is null), so lift is drawn without it and the caption reads
"fees unknown on shared jobs"; and there is no ellipsis column.

Three ways in, one page:

1. **Signed-in audience member** (corporation, alliance or public share):
   the page reads the views as the caller; RLS and the view's presentation do
   the rest.
2. **Signed link** `?share=<signature>`: `src/app/industry/access.ts`
   `resolveJobShare(param, grantor)` reads the one candidate row on the
   service role (the anchor's share by `character_directory`, or the
   corporation's), verifies the signature (`verifyShareToken`, `TOKEN_SALT`;
   legacy `<id>.<sig>` narrows), and returns a scope: the account's
   registration ids, its main (or none), and the hidden job ids for that
   scope — or the corporation id and its hidden ids. The page then reads with
   a service client **scoped to that set, `is_current`, minus the hidden ids,
   `cost` dropped and every row's owner rewritten to the main before render**
   — the asset share page's discipline, since the service role sees neither
   the policies nor the view's `case`. Signed-out allowed. The corp path also
   checks `corp_share_author_active()` through the directory, so a link
   outlives its author exactly as long as the RLS path does.
3. **Fully public, signed out**: the same resolver with no signature, taking
   the row only when it names no one (`isPublic`), as `/bpos` and the phase
   12 structure path do.

The list page is a `noindex` page like the other share pages; no card image
in this phase (Non-goals).

### "Shared with you" on `/industry`

Below the header, a one-line strip — "Shared with you: Sir Cuddles ·
Goonwaffe" — linking to the grantor pages, drawn from the share rows the
caller's RLS shows minus their own (the `sharedWithMe` discipline): character
shares named by the sharer's main through `visible_job_owners()` and
`character_directory` (or "a private owner" with no main set), corp shares by
the corporation. Empty means the strip is not drawn.

### Structures — the Characters tab

Nothing to build: the tab already groups personal jobs by the row's
`registration_id` and corp jobs by `corporation_id`, and the view now hands
it the main for every row that is not ours. Its header reads "by main
character and corporation", the `installers.ts` comment is rewritten, and its
unit test gains a case where two co-tenant registrations arrive as one main.
Hidden jobs are absent from the tab, from the tile's Total EIV and from the
active-jobs list, with nothing drawn in their place.

## GraphQL and MCP

Opt-in, like `include_shared` everywhere else; session mode only for
GraphQL.

- **GraphQL** `industryJobs(…, includeShared: Boolean = false)`: widens the
  leak-guard `.in()` on the character side with the **main** registration ids
  from `visible_job_owners()` (the view already presents the main, so the
  filter column is the main's uuid) and on the corp side with the grantor
  corporations of readable `corp_industry_job_share` rows, and lets RLS
  decide; an owner filter still narrows only the caller's own owners (phase
  04's rule, verbatim). Rows carry `shared: Boolean!` (the view's `own`
  inverted) and `cost` is null on them. `sharedWithMe` gains an optional
  `subject: ASSET | INDUSTRY_JOBS` on `ShareGrant` (default `ASSET`, so
  existing queries read unchanged) and lists job shares with `ownerType`
  `character` (the main) or `corporation`, no `itemId`.
- **MCP** `list_industry_jobs(include_shared?: boolean)`: default false; live
  only — refused with `as_of`, as the asset tools refuse it, because the
  time-travel RPCs take owner lists and a recipient has no business handing
  them a grantor's. With it, the two live reads drop their owner filter in
  favour of own ∪ grantors, rows report `shared: true`, and `owner` resolves
  the presented main through `character_directory` or the corporation
  through `corporation`. `annotations` unchanged (`readOnlyHint: true`).
- **Links** need nothing: a Link runs under its creator's context, and a
  creator who is a recipient gets shared rows only if their query asks for
  `includeShared`.

## PR plan

| PR  | Contents                                                                                                                                                                                                                                                                          | Depends on | Blast radius                                                                                                                                                                      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | ✅ **Built** — migration `20261016004245`. `industry_job_hidden` + policies, `hidden_industry_job_ids()`, the conjunct on both tenant policies. `/industry` ellipsis menu (`jobMenu.tsx`) + `hiddenActions.ts`. `test/sql/industry_job_hidden.sql`.                                                  | —          | An empty table: nothing changes until someone hides a job.                                                                                                                        |
| 2   | `corp_industry_job_share`, `character_industry_job_share`, `job_sharing_registrations()`, owner + audience policies, grants. Nothing reads them. `test/sql/industry_job_share.sql` (share-table half).                                                                             | 1          | None. Pure additive schema.                                                                                                                                                       |
| 3   | The two widening policies, `anon` grants; `visible_job_owners()`; both views recreated with the presented owner, masked `installer_id` and `own`. `installers.ts` comment/test, Characters tab header. `explain analyze` numbers into this doc. Policy half of the SQL test + recursion smoke. | 2          | **The presentation cutover**: co-tenant rows on `/structure` switch from per-character to per-main the day this merges (owner's call, question 3). The view recreate is rehearsed per migration `20261008005932`'s note. |
| 4   | Share button + chooser on `/industry`, `shareActions.ts`, grantor pages, `access.ts` + `?share=` + public path, "Shared with you" strip. Unit tests for `jobShareSubject.ts`.                                                                                                       | 3          | UI on a proven substrate.                                                                                                                                                         |
| 5   | GraphQL `includeShared` on `industryJobs`, `sharedWithMe.subject`; MCP `include_shared`.                                                                                                                                                                                          | 3          | Opt-in flags; nothing changes for callers who do not pass them.                                                                                                                   |

Each migration takes its timestamp from the clock (`pnpm run db:new`), each
edits `schema.sql` too, and PR 3's doc update rewrites the Characters-tab
paragraph in CLAUDE.md.

## Verification

- **`test/sql/industry_job_hidden.sql`** (the `tenant_industry_jobs.sql`
  harness): A and B tenants at one structure; B reads A's job; A inserts the
  hidden row → B reads nothing, A still reads it; A's reconcile closes and
  inserts a new version → still hidden (keyed on `job_id`); A deletes the row
  → B reads it again; B's insert naming A's job is refused by `with check`
  (A's row is not readable to B's owner predicate); A's insert naming a job A
  does not own is refused; corp: a member hides, a second member on another
  account unhides, a non-member's insert and delete touch nothing;
  `hidden_by` of another account's registration is refused; one `job_id`
  present in both job tables is hidden in both.
- **`test/sql/industry_job_share.sql`**: account A (main + alt, jobs on both,
  one hidden) and corporation C (two members on two accounts). Assert: A's
  share to corp X → member B of X reads both characters' current rows **all
  with `registration_id` = A's main and `cost` null**, not the hidden job,
  not any history row, nothing from A's asset or blueprint tables;
  `job_sharing_registrations()` and `visible_job_owners()` as B return only
  A's registrations holding a visible current job, and the latter maps them
  to A's main; with A's main unset, every widened row reads a null owner;
  revoke → B reads nothing on the next statement; a link-only row matches
  nobody under RLS; a fully public row is read by `anon`; C's share by member
  M → an alliance-mate reads C's rows with `installer_id` null, loses them
  when M's directory row leaves C, regains them when the other member
  re-saves; a co-tenant with no share also reads A's rows as the main; a
  stranger reads nothing throughout; a policy-level smoke as `authenticated`
  proving no recursion on either table.
- **The two-account leak test** (README): B signed in sees exactly A's shared
  jobs, owned by A's main, on `/industry/character/<A's main>` and in
  `industryJobs(includeShared: true)`, and nothing on `/industry` itself or in
  `assets(includeShared:)`; anon sees a public share signed-out; a hidden job
  is absent on every surface, the `?share=` page included; revoking closes
  access on the next request.
- `pnpm run lint`, `pnpm test`, `pnpm run build`, `pnpm run test:sql` against a
  throwaway database, every PR.

## Non-goals

- **No per-structure or per-job share subject.** The share covers the scope;
  the hidden row is the per-job knob. Phase 13's `(character, structure)`
  grant is not revived.
- **No `totals` pool, no `structure_eiv_daily`.** Phase 13's pooled
  throughput stays unbuilt; nobody has asked for the pooled number since the
  co-tenant view shipped.
- **No card image** for the grantor pages in this phase; a chat unfurl of a
  job list is a follow-up if anyone shares one into Discord.
- **No change to the `_over_time` residual** from phase 13 beyond noting
  that hidden rows are now excluded from direct reads too. A direct read of
  the tables still carries `cost` and the raw `registration_id` on widened
  rows; masking both inside `character_industry_jobs()` /
  `corp_industry_jobs()` and revoking the table grant from `authenticated` is
  the fix, and belongs with the time-travel RPCs.
- **No share of `cost`, ever** in this phase (question 4).
- **No tenants audience on job shares.** Phase 12's `tenants` flag is a
  structure share's audience; for jobs, co-tenancy is already the default
  grant, so a `tenants` flag would be redundant with phase 13.
- **No notification to co-tenants** when a job is hidden, and nothing drawn
  where it was — that is the requirement.
