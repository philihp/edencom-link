# Phase 12: structure shares

**Status: 🚧 PR A and PR B built; PR C (UI) in progress.** Supersedes Stage D
of `design.md`, which sketched `corp_structure_share` before the Revision 3
audience shape existed. PR A shipped as #1068 (`structure_tenant`), and #1101
then redefined tenancy as "a job within the last 30 days" (`last_job_seen_at`)
rather than `open_jobs > 0` — this document reads that way throughout. PR B is
the cutover: `corp_structure_share` (migration `20261014220310`), the seeded
alliance default, the two hard-coded alliance policies dropped, and
`test/sql/structure_share.sql`. The plan is three PRs; each one leaves
production working.

A structure's owner can share the structure's details the standard way — with
corporations, with alliances, with a signed link, or with everyone — **and**,
new for this subject, with _the people who run jobs there_: every account that
has had an industry job in the structure within the last 30 days (the
`is_tenant_of()` window). That last audience is what the next phase
([13-industry-job-share.md](13-industry-job-share.md)) also uses, so this
phase builds the tenancy fact both phases read.

## What a structure share opens

"Structure details" means the rows the two structure pages draw from
`corp_structure` and `corp_structure_rig`:

| Table                   | Columns opened by a share                                                                        | Today's audience                            |
| ----------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| `corp_structure`        | name, type, system, `state`, `services`, reinforcement hours, `unanchors_at`, `last_seen_at`     | own corps, plus a hard-coded alliance policy |
| `corp_structure_rig`    | fitted rigs (the ME/TE bonuses a job at the structure gets)                                      | own corps, plus the same hard-coded policy  |

A share never opens:

- `corp_structure_status` — the fuel timer and `profile_id`. Directors only,
  as today. A fuel expiry is a countdown to when the structure stops shooting
  back.
- `corp_wallet_journal` and everything derived from it: revenue, taxes paid,
  cost avoidance, the recovered tax rate. Those are the owner's books.
- The owner's own industry jobs at the structure (own-only, as today; phase 13
  is the one grant that widens jobs, and it is the job _owner's_ grant).

The public directory (`universe_structure`: name, system, type, owner) already
reaches every established account, so a share adds the rich row, not the
existence of the structure.

## The tenancy fact: `structure_tenant`

"People with jobs in the structure" cannot be evaluated inside a policy by
reading the job tables: phase 13 puts a widening policy on
`character_industry_job_over_time`, and a policy on that table that also
_queries_ that table recurses (Postgres refuses it; phase 02 needed its one
sanctioned SECURITY DEFINER to break exactly this cycle). It is also a cold
scan of a big table on every row check.

Instead the two industry-job extracts record tenancy as a fact, the way
`corp_job_access` records observed director capability. **As shipped** (PR A,
#1068, then #1101): `structure_tenant` is keyed on `(owner_key, structure_id)`
— one row per registration-or-corporation and structure — carrying
`open_jobs` and `last_job_seen_at`, and the predicate is the **30-day
window**, not the open-job count:

```sql
create or replace function public.is_tenant_of(structure bigint)
returns boolean language sql stable
set search_path = public
as $$
  select exists (
    select 1 from public.structure_tenant t
    where t.structure_id = structure
      and t.last_job_seen_at >= now() - interval '30 days'
      and (
        t.registration_id in (select id from public.registration where user_id = (select auth.uid()))
        or t.corporation_id in (select public.my_corporation_ids())
      )
  );
$$;
```

- **Written by** `character-industry-jobs` (per registration) and
  `corp-industry-jobs` (per corporation), at the end of each reconcile, from
  the listing the run just fetched (`recordStructureTenancy` in
  `src/jobs/lib.js`, pure fold `src/jobs/structureTenancy.js`): every
  structure with an `active`, `paused` or `ready` job gets its row upserted
  with the count and `last_job_seen_at = run clock`; this owner's other rows
  are zeroed, never deleted. Best-effort like `recordCorpJobAccess`.
- **Tenancy is the stamp within 30 days.** `last_job_seen_at` is "the last
  time this owner had something running or undelivered here", so a tenant
  keeps the audience for a month after their last delivery, and a row whose
  extract stopped reporting (token revoked, character unlinked) ages out on
  its own — the two ways `open_jobs > 0` was wrong (#1101).
- **Freshness** is the extract cadence: 6 h per character, daily per corp.
  Acceptable — the audience is "people who build here", not a docking-rights
  check.
- **RLS:** own rows only; service role writes. Nobody can list who else builds
  at a structure. `my_tenant_structure_ids()` is the same predicate as a set,
  for the job-table policies phase 13 shipped.

Because `structure_tenant` is its own table, a policy on `corp_structure` or
on the job tables can call `is_tenant_of()` without touching the table it
protects.

## The share table

Revision 3 shape, corporation grantor, plus the one new audience flag:

```sql
create table public.corp_structure_share (
  id uuid primary key default gen_random_uuid(),
  -- Grantor: the corporation that owns the structure (corp_structure.corporation_id).
  corporation_id bigint not null,
  -- Subject. Null = every structure this corporation owns, now and later.
  -- Only the seeded default uses null (below); the dialog edits one structure.
  structure_id bigint,
  -- (a) (b) (c) as in every Revision 3 share table.
  corporation_ids bigint[] not null default '{}',
  alliance_ids    bigint[] not null default '{}',
  secret text,
  -- (e) NEW: everyone with a job in the structure in the last 30 days
  -- (is_tenant_of). Per structure only: never true on a null-subject row.
  tenants boolean not null default false,
  -- True on the row the migration/extract seeded; cleared by the first
  -- director edit. While true the extract keeps alliance_ids equal to the
  -- corporation's current alliance (see "The alliance default").
  seeded_default boolean not null default false,
  -- Audit: which registration saved it last (a director's character).
  updated_by uuid references public.registration (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (structure_id is not null or not tenants),
  -- A seeded row carries nothing but its alliance grant.
  check (not seeded_default or (secret is null and corporation_ids = '{}' and not tenants)),
  unique nulls not distinct (corporation_id, structure_id)
);
```

**Fully public** stays the row state that names no one: `secret is null and
corporation_ids = '{}' and alliance_ids = '{}' and not tenants and not
seeded_default`. The `tenants` flag is a fourth independent grant path that
composes with the others exactly as the arrays and the secret do — but it
_names someone_, so a row with only `tenants` set is never public. Nor is a
seeded row whose corporation is in no alliance (`alliance_ids = '{}'`): it
matches nobody until the corp joins one. Both are what `share_audience_matches()`
would otherwise read as "everyone", which is why every policy on this subject
goes through one predicate, `structure_share_matches(structure_id,
corporation_ids, alliance_ids, secret, tenants, seeded_default)`:

```sql
  select case
    when seeded_default then alliance_ids && array(select public.my_alliance_ids())
    when tenants then
      corporation_ids && array(select public.my_corporation_ids())
      or alliance_ids && array(select public.my_alliance_ids())
      or (structure_id is not null and public.is_tenant_of(structure_id))
    else public.share_audience_matches(corporation_ids, alliance_ids, secret)
  end
```

(`test/sql/structure_share.sql` caught the first of these on the first run:
the draft policy OR'd `share_audience_matches()` with the tenants branch, and a
tenants-only row opened the structure to a stranger.)

### Who manages it

Directors of the owning corporation. Stage C (`character-roles`, a stated-role
extract) was never built, and the fuel policy already settled the question the
practical way: **observed capability.** A registration listed in
`corp_job_access` for `(corporation_id, job = 'corp-structures')` proved a
director token by fetching this corporation's structures. The same predicate
gates writes here:

```sql
create policy "Directors manage structure shares"
  on public.corp_structure_share for all to authenticated
  using (exists (
    select 1 from public.corp_job_access a
    join public.registration r on r.id = a.registration_id
    where a.corporation_id = corp_structure_share.corporation_id
      and a.job = 'corp-structures'
      and r.user_id = (select auth.uid())))
  with check (/* same predicate */);
```

The corp BPO showcase chose member-manage for its corp shares; structures are
different. A structure's state, services and reinforcement window are
military intel, and the fuel policy already draws the director line for this
subject. Keep that line.

### Audience-read policy (load-bearing)

As on every Revision 3 table, the audience must be able to read the share row
that grants them access, because the widening policies on the subject tables
run as the viewer and can only see share rows the share table shows them.

**Tenant grants are per structure.** A null-subject row never carries
`tenants = true` (check constraint `structure_id is not null or not tenants`;
the dialog never offers it). Evaluating "tenant of any structure of this
corporation" would mean reading `corp_structure` from inside a policy — the
very access being granted — while the seeded default is an alliance grant and
needs no tenancy at all. So the policy has exactly two branches:

```sql
create policy "Audience reads structure shares"
  on public.corp_structure_share for select to authenticated
  using (
    public.structure_share_matches(structure_id, corporation_ids, alliance_ids, secret, tenants, seeded_default)
  );
```

### Widening policies on the subject tables

Replace the two hard-coded "Alliance members read corp structures/rigs"
policies with one share-driven policy each. The own-corps policies stay.

```sql
create policy "Audience reads shared corp structures"
  on public.corp_structure for select to authenticated
  using (exists (
    select 1 from public.corp_structure_share s
    where s.corporation_id = corp_structure.corporation_id
      and (s.structure_id is null or s.structure_id = corp_structure.structure_id)
      and public.structure_share_matches(
        corp_structure.structure_id, s.corporation_ids, s.alliance_ids, s.secret, s.tenants, s.seeded_default)
  ));
```

`corp_structure_rig` gets the same policy keyed on its own
`structure_id`/`corporation_id`. Nothing else in the schema references the
dropped policies (`grep "Alliance members read"` finds only the two).

### The alliance default (cutover parity)

Today every corporation's structures are visible to its whole alliance,
unconditionally and invisibly. The cutover must change nothing on the day it
ships:

1. The migration inserts, for **every** distinct `corporation_id` in
   `corp_structure`, one row `(corporation_id, structure_id = null,
alliance_ids = {alliance_id} or {}, seeded_default = true)`, and stamps
   `corporation.structure_share_seeded_at`. A corp in no alliance is seeded
   too, naming nobody: the dropped policy was dynamic, so a corp that joins an
   alliance next week must start sharing with it next week, and the extract
   below does that only for a row that exists.
2. The `corp-structures` extract, after each corporation's run
   (`src/jobs/structureShareDefault.js`): if the corp has no share row at all
   and `corporation.structure_share_seeded_at` is null, insert the same seeded
   row and stamp `structure_share_seeded_at`. **Seed once**: a director who
   deletes the row has opted out and is never re-seeded.
3. While `seeded_default` is true, the same extract sets `alliance_ids` to
   `{current alliance}` (or `{}` when the corp left its alliance — which, per
   the predicate above, matches nobody rather than everyone). This keeps the
   seeded grant _dynamic_, exactly like the policy it replaces. The first
   director save clears `seeded_default`, and from then on the arrays pin
   specific ids like every other Revision 3 row.

Then drop the two hard-coded policies in the same migration, after the seed.
Parity is verified in the migration with a DO block: every corporation in
`corp_structure` has its seeded row, and every seeded row of a corp in an
alliance names exactly that alliance — the migration aborts otherwise.
Rollback: `docs/sharing-layer/rollback-structure-share.sql` re-creates the two
policies verbatim and drops the table.

## The signed link and the public case

`/structure/[structureId]?share=<signature>` mirrors the ship page:

- `src/app/structure/access.ts` — `resolveStructureShare(param, structureId)`:
  candidate rows are the shares whose subject is this structure or null for
  the owning corporation (`corp_structure.corporation_id`, read with the
  service role because the anonymous caller sees nothing yet); the signature
  picks the row (`verifyShareToken`, `TOKEN_SALT`). Returns the owning
  `corporation_id` and the structure id, nothing else.
- The page, on that path, draws only the share-scoped rows with a service
  client filtered to that one structure: `corp_structure`,
  `corp_structure_rig`, the public index sparkline. **No** status, jobs, tax
  or revenue blocks — the same blocks an alliance-mate does not get today.
  Signed-out is allowed, like ship links.
- Fully public rows are settled app-side too (as the BPO showcase does): a
  signed-in viewer with no other match reads the row through RLS only if a
  public policy branch exists; simpler to keep `share_audience_matches`'s
  public branch (it already treats the empty audience as everyone) and let
  RLS answer for signed-in viewers, while signed-out viewers of a public
  structure go through the same service-role path as a link.

## UI

- `/structure/[structureId]` gains the `ShareDialog` for directors of the
  owning corp (`subjectLabel="structure"`, `urlPath=/structure/<id>`), with
  one addition: a **"People with jobs here"** checkbox. The dialog takes an
  optional `extraAudience` prop (`{ label, checked }`) the way it took
  `showAsMain`, saved through `saveStructureShare(structureId, input)` /
  `revokeStructureShare(structureId)` server actions on the cookie client
  (RLS pins the row to a director). The hint line says what is and is not
  opened: "details, services and rigs — never fuel, revenue or jobs".
- `/structure` gains a Directors-only toggle per owned corporation: "Share
  all structures with `<alliance>`" — the seeded default, visible and
  revocable at last. Turning it off deletes the null-subject row (opt-out);
  turning it on re-inserts it with `seeded_default = true`.
- A shared structure a viewer can see but does not own shows a "shared by
  `<corporation>`" line in place of the director-only blocks, so the empty
  fuel and revenue cells read as "not yours" rather than "broken".
- MCP `list_structures` and GraphQL need no change: they query as the caller,
  so shared rows arrive through RLS — the layer's whole point.

## PR plan

| PR  | Contents                                                                                                                                                                         | Blast radius                                                                          |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| A   | ✅ #1068 (+ #1101): `structure_tenant` + `is_tenant_of()` + bookkeeping in the two industry-job extracts. Backfill in the migration from the current job views.                     | None. Nothing reads it. Backfill is a plain aggregate insert.                         |
| B   | ✅ `corp_structure_share`, policies, seed, `structure_share_seeded_at`, extract seed-once + dynamic default, drop the two hard-coded policies. `test/sql/structure_share.sql`.     | Cutover: parity proved in-migration; rollback script that re-creates the two policies. |
| C   | 🚧 Share dialog + tenants checkbox, `/structure` alliance toggle, `access.ts` + the `?share=` path, "shared by" line.                                                               | UI only, on a proven substrate.                                                       |

## Verification

- `test/sql/structure_share.sql` (throwaway DB): three corporations, one
  alliance, five accounts (director, plain member, alliance-mate, tenant with
  a current `structure_tenant` row, stranger). Asserts: seeded row →
  alliance-mate reads the structure and its rigs, never
  `corp_structure_status`; delete the row → alliance-mate loses it;
  `tenants = true` → the tenant reads exactly that structure and no other of
  the corp's; `last_job_seen_at` 31 days back → tenant loses it on the next
  statement; stranger reads nothing throughout, a tenants-only row and a
  no-alliance seeded row included; a plain member cannot insert, update or
  delete a share row for the corp, and a director cannot stamp another
  account's character or aim a row at another corporation.
- The two-account leak test from the README, per PR.
- Migration B parity check runs inside the migration and aborts on any corp
  with an alliance but no seeded row.

## Non-goals

- No wildcard (all-structures) tenant grant; see the audience-read policy.
- No sharing of fuel, profile, journal-derived figures or the owner's jobs.
- No "docking rights" semantics: tenancy is what the extracts observed, not
  what the structure's access list says.
- Corp-installed jobs count for tenancy (the corp is the tenant); a corp
  member who never installed anything is still a tenant through the corp.
  That matches how the Characters tab already attributes corp jobs.
