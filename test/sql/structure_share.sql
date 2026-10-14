-- SQL-level coverage for the structure-share cutover
-- (supabase/migrations/20261014220310_structure_share.sql, sharing layer
-- phase 12 PR B — docs/sharing-layer/12-structure-share.md, "Verification").
--
-- Two corporations in one alliance (98001 owns S1 and S2, 98002 owns S3), a
-- third in none (98003 owns S4), and five accounts: a director of 98001, a
-- plain member of it, an alliance-mate in 98002, a tenant in 98003 who builds
-- at S1, and a stranger. Asserts, in order: the seed puts the alliance-mate at
-- parity with the dropped policy (structure and rigs, never the status row);
-- the stranger and the not-yet-granted tenant read nothing; a tenants grant
-- opens exactly that structure, and closes when the 30-day window passes;
-- only a director can write a share row; a seeded row of a corp in no
-- alliance names nobody rather than everyone; deleting the seeded row revokes
-- the alliance.
--
-- Run against a THROWAWAY database from the repo root, so the \i below
-- resolves (same harness as tenant_industry_jobs.sql):
--
--   DATABASE_URL='postgresql://…/throwaway' pnpm run test:sql
--
-- Everything runs inside one transaction and rolls back.
begin;

do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin; exception when duplicate_object then null; end $$;

create schema if not exists auth;
create or replace function auth.uid() returns uuid
language sql stable
as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated;
grant usage on schema public to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;

-- ── stand-ins, copied from schema.sql where a policy reads them ────────────
create table public.registration (
  id uuid primary key,
  user_id uuid,
  corporation_id bigint
);
alter table public.registration enable row level security;
create policy "own registrations" on public.registration for select to authenticated
  using (user_id = (select auth.uid()));
grant select on public.registration to anon, authenticated;

create table public.corporation (
  corporation_id bigint primary key,
  name text,
  alliance_id bigint
);
grant select on public.corporation to anon, authenticated;

create or replace function public.my_corporation_ids()
returns setof bigint language sql stable
as $$
  select r.corporation_id from public.registration r
  where r.user_id = (select auth.uid()) and r.corporation_id is not null;
$$;

create or replace function public.my_alliance_ids()
returns setof bigint language sql stable
as $$
  select c.alliance_id
  from public.registration r
  join public.corporation c on c.corporation_id = r.corporation_id
  where r.user_id = (select auth.uid()) and c.alliance_id is not null;
$$;

create or replace function public.share_audience_matches(
  corporation_ids bigint[], alliance_ids bigint[], secret text
)
returns boolean language sql stable
as $$
  select
    (secret is null and corporation_ids = '{}' and alliance_ids = '{}')
    or corporation_ids && array(select public.my_corporation_ids())
    or alliance_ids && array(select public.my_alliance_ids());
$$;
grant execute on function public.share_audience_matches(bigint[], bigint[], text) to anon, authenticated;

create table public.corp_job_access (
  registration_id uuid not null references public.registration (id) on delete cascade,
  corporation_id bigint not null,
  job text not null,
  primary key (registration_id, corporation_id, job)
);
alter table public.corp_job_access enable row level security;
create policy "Users read own corp job access" on public.corp_job_access for select to authenticated
  using (registration_id in (select id from public.registration where user_id = (select auth.uid())));
grant select on public.corp_job_access to authenticated;

-- structure_tenant and is_tenant_of() as migration 20261008050729 left them:
-- tenancy is last_job_seen_at within 30 days, not open_jobs.
create table public.structure_tenant (
  registration_id uuid references public.registration (id) on delete cascade,
  corporation_id bigint,
  structure_id bigint not null,
  open_jobs integer not null default 0,
  last_job_seen_at timestamptz not null default now(),
  owner_key text generated always as (coalesce(registration_id::text, 'corp:' || corporation_id::text)) stored,
  check ((registration_id is null) <> (corporation_id is null)),
  primary key (owner_key, structure_id)
);
alter table public.structure_tenant enable row level security;
create policy "Users read own structure tenancy" on public.structure_tenant for select to authenticated
  using (
    registration_id in (select id from public.registration where user_id = (select auth.uid()))
    or corporation_id in (select public.my_corporation_ids())
  );
grant select on public.structure_tenant to authenticated;

create or replace function public.is_tenant_of(structure bigint)
returns boolean language sql stable set search_path = public
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
grant execute on function public.is_tenant_of(bigint) to authenticated, service_role;

-- The three subject tables, with the own-corps policies and the two
-- hard-coded alliance policies the migration drops.
create table public.corp_structure (
  structure_id bigint primary key,
  corporation_id bigint not null,
  name text
);
alter table public.corp_structure enable row level security;
create policy "Users read structures for own corps" on public.corp_structure for select to authenticated
  using (corporation_id in (select public.my_corporation_ids()));
create policy "Alliance members read corp structures" on public.corp_structure for select to authenticated
  using (exists (
    select 1 from public.corporation owner_corp
    where owner_corp.corporation_id = corp_structure.corporation_id
      and owner_corp.alliance_id is not null
      and owner_corp.alliance_id in (select public.my_alliance_ids())
  ));
grant select on public.corp_structure to authenticated;

create table public.corp_structure_status (
  structure_id bigint primary key references public.corp_structure (structure_id) on delete cascade,
  corporation_id bigint not null,
  fuel_expires timestamptz
);
alter table public.corp_structure_status enable row level security;
create policy "Directors read structure status for own corps" on public.corp_structure_status for select to authenticated
  using (exists (
    select 1 from public.corp_job_access a
    join public.registration r on r.id = a.registration_id
    where a.corporation_id = corp_structure_status.corporation_id
      and a.job = 'corp-structures'
      and r.user_id = (select auth.uid())
  ));
grant select on public.corp_structure_status to authenticated;

create table public.corp_structure_rig (
  structure_id bigint not null,
  location_flag text not null,
  type_id bigint not null,
  corporation_id bigint not null,
  primary key (structure_id, location_flag)
);
alter table public.corp_structure_rig enable row level security;
create policy "Users read structure rigs for own corps" on public.corp_structure_rig for select to authenticated
  using (corporation_id in (select public.my_corporation_ids()));
create policy "Alliance members read corp structure rigs" on public.corp_structure_rig for select to authenticated
  using (exists (
    select 1 from public.corporation owner_corp
    where owner_corp.corporation_id = corp_structure_rig.corporation_id
      and owner_corp.alliance_id is not null
      and owner_corp.alliance_id in (select public.my_alliance_ids())
  ));
grant select on public.corp_structure_rig to authenticated;

-- ── fixtures ──────────────────────────────────────────────────────────────
-- Accounts: alice (aa, director of 98001), bob (bb, member of 98001), carol
-- (cc, alliance-mate in 98002), dave (dd, tenant in 98003 building at S1),
-- erin (ee, stranger in 98004).
insert into public.corporation values
  (98001, 'Owners',        99001),
  (98002, 'Alliance-mates', 99001),
  (98003, 'Tenants',       null),
  (98004, 'Strangers',     null);
insert into public.registration values
  ('00000000-0000-0000-0000-0000000000aa', 'a0000000-0000-0000-0000-000000000000', 98001),
  ('00000000-0000-0000-0000-0000000000bb', 'b0000000-0000-0000-0000-000000000000', 98001),
  ('00000000-0000-0000-0000-0000000000cc', 'c0000000-0000-0000-0000-000000000000', 98002),
  ('00000000-0000-0000-0000-0000000000dd', 'd0000000-0000-0000-0000-000000000000', 98003),
  ('00000000-0000-0000-0000-0000000000ee', 'e0000000-0000-0000-0000-000000000000', 98004);
insert into public.corp_job_access values ('00000000-0000-0000-0000-0000000000aa', 98001, 'corp-structures');
insert into public.corp_structure values
  (1030000000001, 98001, 'S1'),
  (1030000000002, 98001, 'S2'),
  (1030000000003, 98002, 'S3');
insert into public.corp_structure_status values
  (1030000000001, 98001, now() + interval '3 days'),
  (1030000000002, 98001, now() + interval '3 days'),
  (1030000000003, 98002, now() + interval '3 days');
insert into public.corp_structure_rig values
  (1030000000001, 'RigSlot0', 37174, 98001),
  (1030000000002, 'RigSlot0', 37174, 98001),
  (1030000000003, 'RigSlot0', 37174, 98002);
insert into public.structure_tenant (registration_id, structure_id, open_jobs, last_job_seen_at) values
  ('00000000-0000-0000-0000-0000000000dd', 1030000000001, 1, now());

-- Before the cutover: the alliance-mate reads S1 and S2 through the hard-coded
-- policy. The baseline the seed must reproduce.
do $$
declare n int;
begin
  set local role authenticated;
  perform set_config('test.uid', 'c0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.corp_structure;
  if n <> 3 then raise exception 'baseline: alliance-mate should read 3 structures, read %', n; end if;
  reset role;
end $$;

\i supabase/migrations/20261014220310_structure_share.sql

do $$
declare
  n int;
  sid bigint;
begin
  -- ── the seed ──────────────────────────────────────────────────────────
  select count(*) into n from public.corp_structure_share where seeded_default and structure_id is null;
  if n <> 2 then raise exception 'seed: expected 2 seeded rows, got %', n; end if;
  select count(*) into n from public.corp_structure_share
    where corporation_id = 98001 and seeded_default and alliance_ids = array[99001::bigint];
  if n <> 1 then raise exception 'seed: 98001''s seeded row should name alliance 99001'; end if;
  select count(*) into n from public.corporation where structure_share_seeded_at is not null;
  if n <> 2 then raise exception 'seed: expected 2 stamped corporations, got %', n; end if;
  select count(*) into n from pg_policies where policyname like 'Alliance members read corp structure%';
  if n <> 0 then raise exception 'cutover: the hard-coded alliance policies are still there'; end if;

  set local role authenticated;

  -- ── parity: the alliance-mate reads what the dropped policy gave ──────
  perform set_config('test.uid', 'c0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.corp_structure;
  if n <> 3 then raise exception 'parity: alliance-mate should read S1, S2 and own S3, read %', n; end if;
  select count(*) into n from public.corp_structure_rig;
  if n <> 3 then raise exception 'parity: alliance-mate should read 3 rigs, read %', n; end if;
  -- never the status row of a structure that is not their own corp's
  select count(*) into n from public.corp_structure_status where corporation_id = 98001;
  if n <> 0 then raise exception 'leak: alliance-mate reads 98001''s fuel'; end if;
  -- the load-bearing audience read: they see the seeded row that grants it
  select count(*) into n from public.corp_structure_share where corporation_id = 98001;
  if n <> 1 then raise exception 'audience read: alliance-mate should see 98001''s seeded row, saw %', n; end if;

  -- the director reads everything of their own, status included
  perform set_config('test.uid', 'a0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.corp_structure_status where corporation_id = 98001;
  if n <> 2 then raise exception 'director should read own fuel rows, read %', n; end if;

  -- ── the stranger and the not-yet-granted tenant read nothing ──────────
  perform set_config('test.uid', 'e0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.corp_structure;
  if n <> 0 then raise exception 'leak: stranger reads % structure(s)', n; end if;
  select count(*) into n from public.corp_structure_share;
  if n <> 0 then raise exception 'leak: stranger reads % share row(s)', n; end if;

  perform set_config('test.uid', 'd0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.corp_structure;
  if n <> 0 then raise exception 'tenant without a grant reads % structure(s)', n; end if;

  -- ── writes: only a director ───────────────────────────────────────────
  perform set_config('test.uid', 'b0000000-0000-0000-0000-000000000000', true);
  begin
    insert into public.corp_structure_share (corporation_id, structure_id, tenants, updated_by)
      values (98001, 1030000000001, true, '00000000-0000-0000-0000-0000000000bb');
    raise exception 'a plain member inserted a share row';
  exception when insufficient_privilege then null;
  end;
  update public.corp_structure_share set alliance_ids = '{}' where corporation_id = 98001;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'a plain member updated % share row(s)', n; end if;
  delete from public.corp_structure_share where corporation_id = 98001;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'a plain member deleted % share row(s)', n; end if;

  perform set_config('test.uid', 'a0000000-0000-0000-0000-000000000000', true);
  -- a director cannot stamp someone else's character as the author
  begin
    insert into public.corp_structure_share (corporation_id, structure_id, tenants, updated_by)
      values (98001, 1030000000001, true, '00000000-0000-0000-0000-0000000000cc');
    raise exception 'a director stamped another account''s character as updated_by';
  exception when insufficient_privilege then null;
  end;
  -- nor aim a row at a corporation they are not a director of
  begin
    insert into public.corp_structure_share (corporation_id, structure_id, updated_by)
      values (98002, 1030000000003, '00000000-0000-0000-0000-0000000000aa');
    raise exception 'a director wrote a share for another corporation';
  exception when insufficient_privilege then null;
  end;
  -- the two check constraints
  begin
    insert into public.corp_structure_share (corporation_id, structure_id, tenants, updated_by)
      values (98001, null, true, '00000000-0000-0000-0000-0000000000aa');
    raise exception 'a null-subject row took tenants = true';
  exception when check_violation then null;
  end;
  begin
    insert into public.corp_structure_share (corporation_id, structure_id, tenants, seeded_default, updated_by)
      values (98001, 1030000000002, true, true, '00000000-0000-0000-0000-0000000000aa');
    raise exception 'a seeded row took tenants = true';
  exception when check_violation then null;
  end;

  -- ── the tenants grant opens exactly that structure ────────────────────
  insert into public.corp_structure_share (corporation_id, structure_id, tenants, updated_by)
    values (98001, 1030000000001, true, '00000000-0000-0000-0000-0000000000aa');

  perform set_config('test.uid', 'd0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.corp_structure;
  if n <> 1 then raise exception 'tenant should read exactly S1, read %', n; end if;
  select structure_id into sid from public.corp_structure;
  if sid <> 1030000000001 then raise exception 'tenant read %, not S1', sid; end if;
  select count(*) into n from public.corp_structure_rig;
  if n <> 1 then raise exception 'tenant should read S1''s rig only, read %', n; end if;
  select count(*) into n from public.corp_structure_status;
  if n <> 0 then raise exception 'leak: tenant reads fuel'; end if;
  select count(*) into n from public.corp_structure_share;
  if n <> 1 then raise exception 'audience read: tenant should see the tenants row, saw %', n; end if;

  -- the stranger is unmoved by it
  perform set_config('test.uid', 'e0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.corp_structure;
  if n <> 0 then raise exception 'leak: stranger reads % structure(s) after the tenants grant', n; end if;

  reset role;
  -- ── the 30-day window closes it ───────────────────────────────────────
  update public.structure_tenant set last_job_seen_at = now() - interval '31 days'
    where registration_id = '00000000-0000-0000-0000-0000000000dd';
  set local role authenticated;
  perform set_config('test.uid', 'd0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.corp_structure;
  if n <> 0 then raise exception 'tenant 31 days gone still reads % structure(s)', n; end if;

  -- ── a seeded row naming no alliance is not public ─────────────────────
  reset role;
  insert into public.corp_structure values (1030000000004, 98003, 'S4');
  insert into public.corp_structure_rig values (1030000000004, 'RigSlot0', 37174, 98003);
  insert into public.corp_structure_share (corporation_id, structure_id, alliance_ids, seeded_default)
    values (98003, null, '{}', true);
  set local role authenticated;
  perform set_config('test.uid', 'e0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.corp_structure where corporation_id = 98003;
  if n <> 0 then raise exception 'leak: a seeded row with no alliance read as public'; end if;
  -- …whereas an EDITED row naming no one is the fully-public state
  reset role;
  update public.corp_structure_share set seeded_default = false where corporation_id = 98003;
  set local role authenticated;
  perform set_config('test.uid', 'e0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.corp_structure where corporation_id = 98003;
  if n <> 1 then raise exception 'a public share should open S4 to the stranger'; end if;
  select count(*) into n from public.corp_structure_rig where corporation_id = 98003;
  if n <> 1 then raise exception 'a public share should open S4''s rig to the stranger'; end if;

  -- ── the director's first edit clears the seed, and revoking closes it ─
  perform set_config('test.uid', 'a0000000-0000-0000-0000-000000000000', true);
  update public.corp_structure_share
    set seeded_default = false, updated_by = '00000000-0000-0000-0000-0000000000aa'
    where corporation_id = 98001 and structure_id is null;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'director could not edit the seeded row'; end if;
  perform set_config('test.uid', 'c0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.corp_structure where corporation_id = 98001;
  if n <> 2 then raise exception 'an edited row still naming the alliance should keep S1 and S2 open'; end if;

  perform set_config('test.uid', 'a0000000-0000-0000-0000-000000000000', true);
  delete from public.corp_structure_share where corporation_id = 98001 and structure_id is null;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'director could not delete the alliance row'; end if;
  perform set_config('test.uid', 'c0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.corp_structure where corporation_id = 98001;
  if n <> 0 then raise exception 'revoke: alliance-mate still reads % of 98001''s structures', n; end if;
  select count(*) into n from public.corp_structure_rig where corporation_id = 98001;
  if n <> 0 then raise exception 'revoke: alliance-mate still reads % of 98001''s rigs', n; end if;
  -- their own corp's structure is untouched
  select count(*) into n from public.corp_structure where corporation_id = 98002;
  if n <> 1 then raise exception 'alliance-mate lost their own S3'; end if;

  reset role;
  raise notice 'structure_share: ok';
end $$;

rollback;
