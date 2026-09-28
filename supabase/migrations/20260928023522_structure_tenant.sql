-- structure_tenant: who holds an open industry job at which player structure
-- (docs/sharing-layer/12-structure-share.md, PR A). The fact behind the
-- "people with jobs here" share audience, recorded by the two industry-job
-- extracts the way corp_job_access records observed director capability, so
-- that a share policy can ask "is the caller a tenant of this structure"
-- without reading the job tables — a policy on a job table that reads that
-- same table recurses, which is the trap phase 02 needed its one SECURITY
-- DEFINER to escape.
--
-- Nothing reads this yet. Phase 12 PR B (corp_structure_share) and phase 13
-- (character_industry_job_share) put it behind their audience policies.

create table public.structure_tenant (
  -- Exactly one owner key: a personal job's registration, or the corporation a
  -- corp-installed job was run for (the Characters tab attributes corp jobs
  -- the same way).
  registration_id uuid references public.registration (id) on delete cascade,
  corporation_id  bigint,
  structure_id    bigint not null,
  -- Jobs at this structure that are active, paused or ready (finished, not
  -- delivered). Zero once none remain: the row is kept so a returning tenant
  -- is an update, and last_job_seen_at still says when they were last here.
  open_jobs        integer not null default 0,
  last_job_seen_at timestamptz not null default now(),
  -- Folds the two owner keys into one non-null discriminator (the
  -- heartbeat.owner_key trick), so one primary key covers both owner kinds
  -- and the extract's upsert has a conflict target.
  owner_key text generated always as (coalesce(registration_id::text, 'corp:' || corporation_id::text)) stored,
  check ((registration_id is null) <> (corporation_id is null)),
  check (open_jobs >= 0),
  primary key (owner_key, structure_id)
);
-- "Who is a tenant here": partial, since is_tenant_of() only ever asks about
-- open jobs, and the zeroed rows are the long tail.
create index structure_tenant_structure_id_idx on public.structure_tenant (structure_id) where open_jobs > 0;
create index structure_tenant_registration_id_idx on public.structure_tenant (registration_id);
create index structure_tenant_corporation_id_idx on public.structure_tenant (corporation_id);

alter table public.structure_tenant enable row level security;
-- Own rows only: a character's through its registration, a corporation's
-- through membership. Nobody can list who else builds at a structure; the
-- predicate below answers only yes or no about the caller.
create policy "Users read own structure tenancy"
  on public.structure_tenant
  for select
  to authenticated
  using (
    registration_id in (
      select id from public.registration where user_id = (select auth.uid())
    )
    or corporation_id in (select public.my_corporation_ids())
  );

grant select on public.structure_tenant to authenticated;
grant all    on public.structure_tenant to service_role;

-- Does the caller hold an open job at this structure, personally or through
-- a corporation of theirs? Invoker rights: it reads only the caller's own
-- rows, which is all the policy above shows anyway. Safe to call from a
-- policy on any table but structure_tenant itself.
create or replace function public.is_tenant_of(structure bigint)
returns boolean
language sql
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.structure_tenant t
    where t.structure_id = structure
      and t.open_jobs > 0
      and (
        t.registration_id in (
          select id from public.registration where user_id = (select auth.uid())
        )
        or t.corporation_id in (select public.my_corporation_ids())
      )
  );
$$;

grant execute on function public.is_tenant_of(bigint) to authenticated, service_role;

-- Backfill from the current job rows, so tenancy is right from the first
-- request rather than after every character's next changed listing (a 304
-- from ESI skips the reconcile, and with it the bookkeeping). Same rule the
-- extracts apply: open statuses only, player structures only (ids from 100
-- billion), Upwell station_id with facility_id as the fallback.
insert into public.structure_tenant (registration_id, corporation_id, structure_id, open_jobs, last_job_seen_at)
select registration_id, null, structure_id, count(*), max(valid_until)
from (
  select registration_id, coalesce(station_id, facility_id) as structure_id, valid_until
  from public.character_industry_job_over_time
  where is_current and status in ('active', 'paused', 'ready')
) j
where structure_id >= 100000000000
group by registration_id, structure_id
union all
select null, corporation_id, structure_id, count(*), max(valid_until)
from (
  select corporation_id, coalesce(station_id, facility_id) as structure_id, valid_until
  from public.corp_industry_job_over_time
  where is_current and status in ('active', 'paused', 'ready')
) j
where structure_id >= 100000000000
group by corporation_id, structure_id
on conflict (owner_key, structure_id) do nothing;

notify pgrst, 'reload schema';
