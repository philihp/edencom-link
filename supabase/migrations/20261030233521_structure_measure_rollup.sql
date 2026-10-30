-- The per-day rollup behind /structure and /structure/[structureId]
-- (docs/structure-measure-rollup.md). The page used to refold every current
-- industry job and every industry_job_tax journal entry the caller could read,
-- on every request, into Revenue, Taxes Paid, Cost Avoidance, Your Total EIV,
-- the recovered facility tax and the Characters tab — linear in job history.
-- The three extracts that write those sources (character-industry-jobs,
-- corp-industry-jobs, corp-wallet-journal) now maintain two tables of
-- per-(structure, owner, UTC day) figures as they reconcile
-- (src/jobs/structureMeasures.js over the pure fold in
-- src/app/structure/measureRollup.ts), and the pages sum a window of days.
--
-- Every figure is per OWNER — a registration or a corporation, folded into one
-- owner_key the way structure_tenant does it — because the page's figures are
-- RLS-scoped to the signed-in account, and an account is a set of owners: its
-- Revenue is the sum over its corporations' rows, its EIV the sum over its
-- registrations' rows. What is NOT decomposable per owner (whether a charge was
-- billed at our own rate turns on who owns the structure; whether a recovered
-- estimate stands turns on which journals the caller holds) is stored as its
-- basis and decided at read time, exactly as costAvoidance.ts already applied
-- the two rates on the receipt total.

-- ── structure_measure_day ─────────────────────────────────────────────────
-- One row per (structure, owner, UTC day). A registration's row carries its
-- personal jobs' tax charges and the EIV of every job its character installed,
-- personally or as a corporation; a corporation's row carries the corp's jobs'
-- outgoing charges, and — as the owner of a WALLET — the industry tax received
-- into it. structure_id 0 is "the entry named no job we hold": revenue that
-- could not be tied to a structure, and outgoing tax for a job this
-- corporation's extract never listed.
create table public.structure_measure_day (
  structure_id    bigint not null,
  -- Exactly one owner key (structure_tenant's shape).
  registration_id uuid references public.registration (id) on delete cascade,
  corporation_id  bigint,
  utc_day         date not null,
  -- Jobs this owner holds that were installed here that day, any activity.
  jobs            integer not null default 0,
  -- Corporation rows only: industry_job_tax received into this corporation's
  -- wallet for jobs run here, dated by the journal entry. revenue_by_payer is
  -- { "<first_party_id>": isk } so the index page can still break unaccounted
  -- revenue down by who paid without reading the journal.
  revenue              numeric(20, 2) not null default 0,
  revenue_by_payer     jsonb not null default '{}',
  -- Facility tax this owner's jobs were charged, once per job: the outgoing
  -- entry in the corporation's wallet for a corp-installed job, else the
  -- receipt in the landlord's wallet for a personal job (a character's wallet
  -- has no journal here, so the receipt is its only record).
  -- tax_paid_by_landlord is { "<corporation_id>": isk }, the "taxes paid
  -- elsewhere" breakdown for rows at structures the page does not list.
  tax_paid             numeric(20, 2) not null default 0,
  tax_paid_by_landlord jsonb not null default '{}',
  -- The cost-avoidance basis: facility tax charged on a job of this owner's,
  -- with how many jobs it covers. Counted toward avoidance only where the
  -- reader's own corporations own the structure — that is the one test the
  -- rollup cannot make, so the page applies it.
  own_job_tax          numeric(20, 2) not null default 0,
  own_job_tax_jobs     integer not null default 0,
  -- Registration rows only: Your Total EIV — the ME0 bill of each
  -- manufacturing/reaction job this registration's character installed, priced
  -- at CCP's adjusted prices as they stood when the row was computed.
  eiv             double precision not null default 0,
  eiv_jobs        integer not null default 0,
  -- The recovered facility tax (src/app/structure/eiv.ts) over the subset of
  -- those jobs the journal did not bill: cost − index fee − SCC. Stored
  -- unconditionally; the page suppresses it where a journal of the reader's
  -- covers the structure's owner, since the exact row wins there.
  recovered_tax   double precision not null default 0,
  recovered_eiv   double precision not null default 0,
  recovered_jobs  integer not null default 0,
  -- Jobs that would have counted but lacked a bill, a price or an index.
  unpriced_jobs   integer not null default 0,
  computed_at     timestamptz not null default now(),
  owner_key text generated always as (coalesce(registration_id::text, 'corp:' || corporation_id::text)) stored,
  check ((registration_id is null) <> (corporation_id is null)),
  primary key (structure_id, owner_key, utc_day)
);
-- The page reads a window of days per owner; the writer deletes stale days per
-- owner. Both are one range scan on these.
create index structure_measure_day_registration_idx on public.structure_measure_day (registration_id, utc_day desc);
create index structure_measure_day_corporation_idx  on public.structure_measure_day (corporation_id, utc_day desc);

alter table public.structure_measure_day enable row level security;
-- Own rows only, on the predicates the job tables use for ownership: a
-- registration's through the account, a corporation's through membership.
create policy "Users read own structure measures"
  on public.structure_measure_day
  for select
  to authenticated
  using (
    registration_id in (
      select id from public.registration where user_id = (select auth.uid())
    )
    or corporation_id in (select public.my_corporation_ids())
  );

grant select on public.structure_measure_day to authenticated;
grant all    on public.structure_measure_day to service_role;

-- ── structure_installer_day ───────────────────────────────────────────────
-- The Characters tab: one row per (structure, owner, UTC day) with how many
-- jobs the owner installed there and their summed EIV. A registration row is
-- one character (character_id names it; the key the tab groups on); a
-- corporation row is the corporation, with installer_ids the distinct
-- characters who installed its jobs that day. Readable by the owner and by
-- every tenant of the structure (my_tenant_structure_ids(), the same audience
-- that reads each other's current jobs), which is why the per-job opt-out
-- industry_job_hidden has to be honoured here too: a hidden job's share is
-- kept in the hidden_* columns, which the structure_installer_day view blanks
-- for anyone but the owner.
create table public.structure_installer_day_all (
  structure_id    bigint not null,
  registration_id uuid references public.registration (id) on delete cascade,
  corporation_id  bigint,
  utc_day         date not null,
  -- Registration rows: the registration's EVE character id at write time.
  character_id    bigint,
  jobs            integer not null default 0,
  eiv             double precision not null default 0,
  installer_ids   bigint[] not null default '{}',
  hidden_jobs     integer not null default 0,
  hidden_eiv      double precision not null default 0,
  hidden_installer_ids bigint[] not null default '{}',
  computed_at     timestamptz not null default now(),
  owner_key text generated always as (coalesce(registration_id::text, 'corp:' || corporation_id::text)) stored,
  check ((registration_id is null) <> (corporation_id is null)),
  primary key (structure_id, owner_key, utc_day)
);
create index structure_installer_day_all_registration_idx on public.structure_installer_day_all (registration_id, utc_day desc);
create index structure_installer_day_all_corporation_idx  on public.structure_installer_day_all (corporation_id, utc_day desc);
-- The tab asks by structure over a window.
create index structure_installer_day_all_structure_idx on public.structure_installer_day_all (structure_id, utc_day desc);

alter table public.structure_installer_day_all enable row level security;
create policy "Users read own installer rollup"
  on public.structure_installer_day_all
  for select
  to authenticated
  using (
    registration_id in (
      select id from public.registration where user_id = (select auth.uid())
    )
    or corporation_id in (select public.my_corporation_ids())
  );
create policy "Tenants read the installer rollup at shared structures"
  on public.structure_installer_day_all
  for select
  to authenticated
  using (structure_id in (select public.my_tenant_structure_ids()));

grant select on public.structure_installer_day_all to authenticated;
grant all    on public.structure_installer_day_all to service_role;

-- What the page reads. security_invoker keeps the table's RLS in force; the
-- hidden_* columns are blanked unless the row is the caller's own, the way the
-- job views blank a co-tenant's cost.
create view public.structure_installer_day with (security_invoker = on) as
  select
    structure_id, registration_id, corporation_id, owner_key, utc_day, character_id,
    jobs, eiv, installer_ids,
    case when owned then hidden_jobs else 0 end as hidden_jobs,
    case when owned then hidden_eiv else 0 end as hidden_eiv,
    case when owned then hidden_installer_ids else '{}'::bigint[] end as hidden_installer_ids,
    computed_at
  from (
    select
      d.*,
      (
        d.registration_id in (select id from public.registration where user_id = (select auth.uid()))
        or d.corporation_id in (select public.my_corporation_ids())
      ) as owned
    from public.structure_installer_day_all d
  ) d;

grant select on public.structure_installer_day to authenticated;

-- ── structure_measure_structure_ids ───────────────────────────────────────
-- Every player structure one of the caller's own jobs has ever been installed
-- in, from the rollup — the /structure roster's discovery of "everyone else's
-- structures", which used to drain both job views for their facility ids.
-- Rows with jobs name a job this owner holds; rows with eiv_jobs name one its
-- character installed as a corporation. Revenue-only rows are left out on
-- purpose: discovery is seeded from OUR jobs, never from who paid us. Invoker
-- rights over the caller's own rows.
create or replace function public.structure_measure_structure_ids()
returns setof bigint
language sql
stable
set search_path = public
as $$
  select distinct m.structure_id
  from public.structure_measure_day m
  where m.structure_id >= 100000000000
    and (m.jobs > 0 or m.eiv_jobs > 0)
    and (
      m.registration_id in (
        select id from public.registration where user_id = (select auth.uid())
      )
      or m.corporation_id in (select public.my_corporation_ids())
    );
$$;

grant execute on function public.structure_measure_structure_ids() to authenticated, service_role;

-- ── industry_index_at ─────────────────────────────────────────────────────
-- The cost index in effect at each of many moments, in one call — the
-- market_price_at() shape over industry_system_index. probes is a json array
-- of { key, system_id, activity, as_of }; each answer echoes the caller's key
-- (a timestamptz does not round-trip as the same string) and carries the
-- latest sample at or before as_of (exact), else the earliest after it
-- (exact: false, the nearest observation standing in for a moment the system
-- was not yet tracked), else null. One index lookup per probe over
-- industry_system_index_system_activity_idx. The rollup prices a job's index
-- fee at its install this way; the table is world-readable, so invoker rights.
create or replace function public.industry_index_at(probes jsonb)
returns jsonb
language sql
stable
set search_path = public
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'key', p.key,
        'system_id', p.system_id,
        'activity', p.activity,
        'as_of', p.as_of,
        'cost_index', s.cost_index,
        'exact', s.exact
      )
    ),
    '[]'::jsonb
  )
  from jsonb_to_recordset(probes) as p (key text, system_id bigint, activity text, as_of timestamptz)
  left join lateral (
    (
      select i.cost_index, true as exact
      from public.industry_system_index i
      where i.system_id = p.system_id and i.activity = p.activity and i.recorded_at <= p.as_of
      order by i.recorded_at desc
      limit 1
    )
    union all
    (
      select i.cost_index, false as exact
      from public.industry_system_index i
      where i.system_id = p.system_id and i.activity = p.activity and i.recorded_at > p.as_of
      order by i.recorded_at asc
      limit 1
    )
    limit 1
  ) s on true;
$$;

grant execute on function public.industry_index_at(jsonb) to anon, authenticated, service_role;

-- ── the lookups the writer makes ──────────────────────────────────────────
-- A registration's EIV covers the corp jobs its character installed, so the
-- corp table is asked by installer.
create index if not exists corp_industry_job_over_time_installer_idx
  on public.corp_industry_job_over_time (installer_id, start_date) where is_current;
-- A job's tax entries, by the job. Same index #1208 adds for the page's
-- industry_job_tax_facility() probe; `if not exists` so either PR may land
-- first.
create index if not exists corp_wallet_journal_industry_tax_context_idx
  on public.corp_wallet_journal (context_id) where ref_type = 'industry_job_tax';
