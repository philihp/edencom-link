# Phase 12: structure shares

**Status: 📝 planned.** Supersedes Stage D of `design.md`, which sketched
`corp_structure_share` before the Revision 3 audience shape existed. Nothing
here is built. The plan is three PRs; each one leaves production working.

A structure's owner can share the structure's details the standard way — with
corporations, with alliances, with a signed link, or with everyone — **and**,
new for this subject, with _the people who run jobs there_: every account that
holds an active or undelivered industry job in the structure. That last
audience is what the next phase ([13-industry-job-share.md](13-industry-job-share.md))
also uses, so this phase builds the tenancy fact both phases read.

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

"People with active or undelivered jobs in the structure" cannot be evaluated
inside a policy by reading the job tables: phase 13 puts a widening policy on
`character_industry_job_over_time`, and a policy on that table that also
_queries_ that table recurses (Postgres refuses it; phase 02 needed its one
sanctioned SECURITY DEFINER to break exactly this cycle). It is also a cold
scan of a big table on every row check.

Instead the two industry-job extracts record tenancy as a fact, the way
`corp_job_access` records observed director capability:

```sql
create table public.structure_tenant (
  -- Exactly one of the two owner keys is set: a personal job's registration,
  -- or the corporation a corp-installed job was run for.
  registration_id uuid references public.registration (id) on delete cascade,
  corporation_id  bigint,
  structure_id    bigint not null,
  -- Jobs at this structure that are active, paused or ready (finished but
  -- not delivered). Zero once none remain; the row is kept, so a returning
  -- tenant is an update rather than a re-insert, and so last_job_seen_at
  -- keeps saying when they were last here.
  open_jobs        integer not null default 0,
  last_job_seen_at timestamptz not null default now(),
  -- Generated: folds the two owner keys into one non-null discriminator,
  -- the same trick heartbeat.owner_key uses.
  owner_key text generated always as (coalesce(registration_id::text, 'corp:' || corporation_id::text)) stored,
  check ((registration_id is null) <> (corporation_id is null)),
  primary key (owner_key, structure_id)
);
create index structure_tenant_structure_id_idx on public.structure_tenant (structure_id) where open_jobs > 0;
```

- **Written by** `character-industry-jobs` (per registration) and
  `corp-industry-jobs` (per corporation), at the end of each reconcile, from
  the listing the run just fetched: group the fetched jobs by
  `coalesce(station_id, facility_id)` (Upwell structures carry the same id in
  both; `isPlayerStructureId` from `roster.ts` drops NPC stations), count the
  ones whose `status` is `active`, `paused` or `ready`, upsert one row per
  structure, and set `open_jobs = 0` on this owner's rows for structures the
  listing no longer names. Best-effort like `recordCorpJobAccess`: a
  bookkeeping failure never fails an extract that succeeded.
- **Undelivered means undelivered.** A `ready` job keeps its owner a tenant
  for as long as it sits in the structure, which is what the owner asked for
  ("active or undelivered"). `delivered`, `cancelled` and `reverted` do not
  count.
- **Freshness** is the extract cadence: 6 h per character, daily per corp.
  Tenancy therefore lags a delivery by up to one cycle. Acceptable — the
  audience is "people who build here", not a docking-rights check.
- **RLS:** own rows only (`registration_id in my registrations or
corporation_id in my_corporation_ids()`); service role writes. Nobody can
  list who else builds at a structure.
- **The predicate**, invoker rights, no definer:

  ```sql
  create or replace function public.is_tenant_of(structure bigint)
  returns boolean language sql stable
  set search_path = public
  as $$
    select exists (
      select 1 from public.structure_tenant t
      where t.structure_id = structure
        and t.open_jobs > 0
        and (
          t.registration_id in (select id from public.registration where user_id = (select auth.uid()))
          or t.corporation_id in (select public.my_corporation_ids())
        )
    );
  $$;
  ```

  Because `structure_tenant` is its own table, a policy on `corp_structure`
  or on the job tables can call this without touching the table it protects.

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
  -- (e) NEW: everyone who holds an active or undelivered job in the structure
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
  unique nulls not distinct (corporation_id, structure_id)
);
```

**Fully public** stays the row state that names no one: `secret is null and
corporation_ids = '{}' and alliance_ids = '{}' and not tenants`. The
`tenants` flag is a fourth independent grant path that composes with the
others exactly as the arrays and the secret do.

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
    public.share_audience_matches(corporation_ids, alliance_ids, secret)
    or (tenants and public.is_tenant_of(structure_id))
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
      and (public.share_audience_matches(s.corporation_ids, s.alliance_ids, s.secret)
           or (s.tenants and public.is_tenant_of(corp_structure.structure_id)))
  ));
```

`corp_structure_rig` gets the same policy keyed on its own
`structure_id`/`corporation_id`. Nothing else in the schema references the
dropped policies (`grep "Alliance members read"` finds only the two).

### The alliance default (cutover parity)

Today every corporation's structures are visible to its whole alliance,
unconditionally and invisibly. The cutover must change nothing on the day it
ships:

1. The migration inserts, for every distinct `corporation_id` in
   `corp_structure` whose `corporation.alliance_id` is not null, one row
   `(corporation_id, structure_id = null, alliance_ids = {alliance_id},
seeded_default = true)`.
2. The `corp-structures` extract, after each corporation's run: if the corp
   has no share row at all and `corporation.structure_share_seeded_at` is
   null, insert the same seeded row and stamp `structure_share_seeded_at`.
   **Seed once**: a director who deletes the row has opted out and is never
   re-seeded.
3. While `seeded_default` is true, the same extract sets `alliance_ids` to
   `{current alliance}` (or `{}` when the corp left its alliance). This keeps
   the seeded grant _dynamic_, exactly like the policy it replaces. The first
   director save clears `seeded_default`, and from then on the arrays pin
   specific ids like every other Revision 3 row.

Then drop the two hard-coded policies in the same migration, after the seed.
Verify parity in the migration with a DO block: for every corporation in
`corp_structure`, the seeded row exists or the corp has no alliance.

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
| A   | `structure_tenant` + `is_tenant_of()` + bookkeeping in the two industry-job extracts. Backfill in the migration from the current job views.                                        | None. Nothing reads it. Backfill is a plain aggregate insert.                         |
| B   | `corp_structure_share`, policies, seed, `structure_share_seeded_at`, extract seed-once + dynamic default, drop the two hard-coded policies. `test/sql/structure_share.sql`.        | Cutover: parity proved in-migration; rollback script that re-creates the two policies. |
| C   | Share dialog + tenants checkbox, `/structure` alliance toggle, `access.ts` + the `?share=` path, "shared by" line.                                                                  | UI only, on a proven substrate.                                                       |

## Verification

- `test/sql/structure_share.sql` (throwaway DB): two corporations, one
  alliance, three accounts (director, alliance-mate, tenant with a `ready`
  job, stranger). Assert: seeded row → alliance-mate reads the structure and
  its rigs, never `corp_structure_status`; delete the row → alliance-mate
  loses it; `tenants = true` → the tenant reads exactly that structure and no
  other of the corp's; `open_jobs = 0` → tenant loses it on the next
  statement; stranger reads nothing throughout; a non-director cannot insert
  or update a share row for the corp.
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
