# Phase 13: pooled throughput — sharing industry jobs with a structure's tenants

**Status: ✅ shipped — without the opt-in.** Migration
`20261008005932_tenant_industry_jobs.sql`, `test/sql/tenant_industry_jobs.sql`.

> **Decision, 2026-10-08.** Everyone with an open job at a player structure
> reads the *current* job rows of everyone else building there. No share row,
> no dialog, no pool: the structure is the grant. The reasoning: people who
> share a structure are allies by construction (the owner let both of them
> build there), the job count in a system is public in the client anyway, and
> an opsec-sensitive build — a supercapital — is seen only by others the owner
> already trusts with the same kind of thing. What shipped is the `jobs` level
> below, for every tenant, with `cost` masked in the two views
> (`character_industry_job`, `corp_industry_job`) unless the row is the
> caller's own; history never crosses. Both industry-job tables carry a
> tenant policy over `my_tenant_structure_ids()` (the set form of
> `is_tenant_of()`, so a drain of every visible job hashes tenancy once
> instead of probing per row). Consumers that mean "my jobs" (`/industry`,
> `structure_tax_revenue()`, the `/structure` tax ledger) now test ownership
> on the row rather than inferring it from visibility; the `/structure`
> Characters tab and `/structure/[structureId]` name a co-tenant through the
> world-readable `character_directory`. The residual: the `_over_time`
> tables stay readable by `authenticated` for the time-travel RPCs, so a
> direct PostgREST read of the table still carries `cost`.
>
> The rest of this document is the design as planned — the opt-in grant and
> the `totals` pool — kept for the reasoning. Neither table was created.

## Problem

An industry job is visible to its owner and to nobody else. The structure
owner sees tenants only as tax receipts (`structure_tax_revenue`: who paid,
how much, which day), and a tenant sees only their own jobs. So the question
an industrialist actually asks at a shared structure — **"what share of the
throughput here is mine?"** — has no answer for anyone, and the one with the
closest figure (the owner, through receipts) is not the one asking.

An earlier idea was a grant from job owners to the structure owner ("share my
jobs with whoever owns the structure I build in"). That points the wrong way:
the owner already has receipts, and it makes the owner a privileged party in
a relationship between peers. This plan replaces it. The grant goes to **the
other tenants**: everyone who holds an active or undelivered job at the same
structure, with the owner included only when the owner builds there too. The
share is symmetric — you see the pool because you are in the pool.

## What "throughput" is

Estimated Item Value, the number the game bills on: for a manufacturing or
reaction job, `runs × Σ(ME0 material quantity × adjusted_price)` from
`sde_blueprint_product` and `market_adjusted_price` — the same fold
`src/app/structure/eiv.ts` already runs for the tile's **Total EIV**, over the
same window (jobs by `start_date` within `?days=`). Research, copy and
invention jobs push no materials through and contribute nothing, by
construction. This phase computes nothing new; it decides who may see whose.

## Two levels of disclosure, one share row

The share row carries a `detail` level. The first PR ships `totals`; `jobs`
is specified so it can follow without a schema change.

- **`totals`** — your contribution enters a per-structure, per-day pool. Other
  tenants see the pool's EIV, job count and contributor count. They never see
  a row of yours.
- **`jobs`** — your current job rows at the structure become readable to the
  other tenants through a widening RLS policy (blueprint, product, runs,
  status, dates; never `cost`, see below). This is the layer's standard
  mechanism and it is what makes GraphQL, Links and MCP answer consistently,
  but it discloses _what_ you build, which most industrialists guard more
  closely than _how much_.

`totals` answers the stated question with the least disclosure, so it ships
first.

## The grant: `character_industry_job_share`

Per-character grantor, as the alt-privacy invariant requires:

```sql
create table public.character_industry_job_share (
  id uuid primary key default gen_random_uuid(),
  registration_id uuid not null references public.registration (id) on delete cascade,
  -- Subject: this character's jobs at one structure. No wildcard: the
  -- audience-read policy below needs a structure to test tenancy against,
  -- so "every structure I build in" is one row per structure (the dialog
  -- writes them from the character's own structure_tenant rows).
  structure_id bigint not null,
  -- Revision 3 audiences, for the rare "show my corp what I build" case. The
  -- dialog for this subject offers corporations, alliances and tenants; a
  -- signed link is accepted by the shape but not offered.
  corporation_ids bigint[] not null default '{}',
  alliance_ids    bigint[] not null default '{}',
  secret text,
  -- The audience this phase exists for: the structure's other tenants.
  tenants boolean not null default true,
  detail text not null default 'totals' check (detail in ('totals', 'jobs')),
  created_at timestamptz not null default now(),
  unique (registration_id, structure_id)
);
```

Owner policies as on `character_asset_share` (read/insert/update/delete own,
keyed on the registration's `user_id`). The audience-read policy is the
load-bearing one again:

```sql
create policy "Audience reads industry job shares"
  on public.character_industry_job_share for select to authenticated
  using (
    public.share_audience_matches(corporation_ids, alliance_ids, secret)
    or (tenants and public.is_tenant_of(structure_id))
  );
```

A share row says only that a character opted in at one structure, and even
that only to someone who already builds there.

Corp-installed jobs are a second grantor (`corp_industry_job_share`,
corporation grantor, director-managed per phase 12's rule). Defer it: the
pool is honest about coverage either way (below), and personal jobs are where
the question comes from.

## The pool: `structure_eiv_daily`

Totals cannot be served by a policy: a policy can only widen _rows_, and the
whole point of `totals` is that no row crosses accounts. A SECURITY DEFINER
aggregate would do it and is exactly what the layer forbids. A materialized
view cannot carry RLS. So the pool is a **derived table written by the
service role** — the `industry_system_index_bucket` / `corp_job_access`
pattern, a fact the extracts maintain rather than a copy of anyone's rows:

```sql
create table public.structure_eiv_daily (
  structure_id bigint not null,
  day date not null,
  activity text not null,             -- 'manufacturing' | 'reaction'
  jobs integer not null,
  runs bigint not null,
  eiv numeric not null,
  -- Distinct owner keys (registration or corp) whose share covers this
  -- structure and who ran a job here that day. A viewer reads this to judge
  -- how complete the pool is.
  contributors integer not null,
  computed_at timestamptz not null default now(),
  primary key (structure_id, day, activity)
);
```

- **Membership rule.** A job is in the pool for `(structure, day)` iff its
  owner has a `character_industry_job_share` row for that structure with
  `tenants = true`, the job is manufacturing or
  reaction, and its `start_date` falls on that UTC day. Jobs of characters
  who never opted in are absent, and the `contributors` column says how many
  did.
- **Refresh.** One SQL function, `refresh_structure_eiv_daily()`, `revoke
execute` from everyone but the service role (the `ensure_sde_mirror_table`
  precedent). It recomputes the trailing 90 days (the widest page window) and
  upserts, deleting days that now have no contributors. Called at the end of
  the `character-industry-jobs` workflow as a tail step, after every
  character's lane has drained (the SDE mirror's "tail steps run only once
  every file has landed" rule), and again by `market-adjusted-prices`, since
  a price change re-values every bill. Pricing in SQL: `sde_blueprint_product`
  holds `materials` as jsonb `[{typeID, quantity}]`, so the bill is a
  `jsonb_array_elements` join onto `market_adjusted_price`, `runs ×
sum(quantity × adjusted_price)` per job. A job with any unpriced material
  contributes nothing (the fold's posture; `eiv.ts` refuses the same way).
  Keep both computations in agreement with one `test/sql` case that prices a
  known bill both ways.
- **RLS.** Readable when `is_tenant_of(structure_id)`, or when the viewer's
  corporation owns the structure (an owner who never builds there still sees
  the pool of those who opted in — the pool is what tenants agreed to
  publish, and the owner already holds the receipts). Nobody else, including
  a structure share's audience from phase 12: seeing a structure's services
  is not seeing its economy.

### What the pool leaks, said plainly

With two contributors, each can subtract their own EIV from the pool and
learn the other's total for the day. The dialog says so in one line
("anyone building here can work out your total when you are the only other
sharer"), and the row's `contributors` count is shown next to every pooled
figure so the arithmetic is never hidden. That is the disclosure a `totals`
sharer accepts; it is far less than `jobs`. No k-anonymity floor: it would
blank the pool at exactly the small structures where the question is asked.

## The `jobs` level (specified, deferred)

One widening policy on `character_industry_job_over_time`, current rows only:

```sql
create policy "Tenants read shared industry jobs"
  on public.character_industry_job_over_time for select to authenticated
  using (
    is_current
    and exists (
      select 1 from public.character_industry_job_share s
      where s.registration_id = character_industry_job_over_time.registration_id
        and s.detail = 'jobs'
        and s.structure_id = coalesce(character_industry_job_over_time.station_id,
                                      character_industry_job_over_time.facility_id)
        and (public.share_audience_matches(s.corporation_ids, s.alliance_ids, s.secret)
             or (s.tenants and public.is_tenant_of(
                   coalesce(character_industry_job_over_time.station_id,
                            character_industry_job_over_time.facility_id))))
    )
  );
```

No recursion: the policy reads the share table and `structure_tenant`, never
the job table. `cost` must not cross: at a structure whose facility tax the
viewer knows (their own rate at their own structure), `cost` inverts to EIV
per job exactly, and at any structure it inverts to the owner's rate — the
figure `eiv.ts` recovers on purpose for one's _own_ jobs. Rather than a
column policy (Postgres has none), the `character_industry_job` view gains a
`cost` that is `null` unless the row's registration is the viewer's own
(`case when registration_id in (my registrations) then cost end`), and the
GraphQL `industryJobs` field reads the view. The `_over_time` table is never
exposed to GraphQL anyway (README invariant).

## Page

`/structure/[structureId]` gains a **Throughput** block, drawn for tenants and
for the owning corporation:

| Row                     | Source                                                              |
| ----------------------- | ------------------------------------------------------------------- |
| Your EIV, this window   | own current jobs through `foldEiv` (exact; already on the page)      |
| Pooled EIV, this window | `structure_eiv_daily` summed over the window                        |
| Your share              | your ÷ pooled, shown as "of the pooled EIV (N sharers)"             |
| Coverage                | `contributors` (max over the window) — "3 sharers"                  |

When the viewer has not opted in, the block shows the pool and a **"Share my
jobs here"** button in place of "your share": you read the pool because you
are a tenant, but you see your percentage only once you are counted in it —
the symmetric rule, and the one nudge the design allows itself. The button
opens the `ShareDialog` for this subject (`subjectLabel="industry jobs"`,
detail selector `totals`/`jobs`, scope "this structure" or "every structure I
build in" — the latter writes one row per structure the character is a tenant
of today, and says so — corporation/alliance checkboxes, no link).

For the owning corporation the page also keeps the receipts-derived view it
has today. Those two totals will disagree — receipts cover every job billed,
the pool only opted-in ones — and the page labels each with its source
rather than reconciling them.

## PR plan

| PR  | Contents                                                                                                                                      | Depends on   |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| 1   | `character_industry_job_share` + policies; `structure_eiv_daily` + `refresh_structure_eiv_daily()` + workflow tail steps. `test/sql/industry_job_share.sql`. | phase 12 PR A |
| 2   | Throughput block, share dialog for the subject, server actions.                                                                                | 1            |
| 3   | `detail = 'jobs'`: the widening policy, the `cost`-masking view change, GraphQL/MCP `includeShared` parity, dialog option.                       | 1, 2         |
| 4   | `corp_industry_job_share` (corporation grantor) if corp-installed jobs turn out to matter at the structures in question.                        | phase 12 PR B |

## Verification

- `test/sql/industry_job_share.sql`: three tenants at one structure, one of
  them the owner; A and B opt in (`totals`), C does not. Assert the pool row
  carries A+B's EIV with `contributors = 2`; C reads the pool (tenant) but
  no job rows; a non-tenant reads neither; C loses the pool once `open_jobs`
  drops to 0; with A on `jobs`, B reads A's current rows with `cost` null and
  C reads them too; nobody reads A's history rows.
- A pricing agreement test: one blueprint, one price list, `foldEiv` in TS
  and `refresh_structure_eiv_daily()` in SQL produce the same number.
- The README's two-account leak test.

## Non-goals and open questions

- No grant to the structure owner as a distinct audience. The owner is a
  tenant when they build there, and holds receipts when they do not.
- No pool across structures ("my share of everything in the alliance"): the
  subject is one structure, the question is about one structure.
- No wildcard subject. "Every structure I build in" is one row per current
  tenancy; a structure the character starts building at later needs a new
  opt-in, which the Throughput block's button offers on the spot.
- **Open:** whether `structure_eiv_daily` should also carry the owner's
  receipts-derived total as a second column the owner can choose to publish
  (a phase 12 share flag). It would give tenants a complete denominator
  without every tenant opting in, at the cost of a service-role step reading
  the owner's journal on the owner's say-so. Left out until someone asks for
  the complete number rather than the pooled one.
