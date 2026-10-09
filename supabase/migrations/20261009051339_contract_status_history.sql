-- Contract status as history (docs/contract-status.md).
--
-- A contract's facts are frozen once it is issued: EVE cannot edit a
-- contract's price, items, route or parties. What moves is its status, plus a
-- few fields that fill in as it moves: who accepted it, and when it was
-- accepted and completed. Those fields stay on the contract row and are
-- updated in place, because before acceptance they were simply empty; there is
-- no earlier value worth keeping. The status moves to an SCD-2 history per
-- owner, so every status a contract held is kept with when it held it.
--
-- character_contract and corp_contract lose their status column. The views
-- character_contract_with_status and corp_contract_with_status put the
-- current status back beside the facts, for readers that want both (the
-- GraphQL contracts list, and through it Data Links, CSV and MCP run_query).

-- ── character_contract_status_over_time ────────────────────────────────────
-- One row per status a character's contract has held. valid_from is when the
-- status began: ESI's own date where it gives one (date_issued for
-- outstanding, date_accepted for in_progress, date_completed for the finished
-- states), else the scan that first saw it (cancelled, deleted, rejected,
-- failed and reversed carry no date in ESI). A change ends the current row at
-- the new row's valid_from, so the rows are contiguous. On the current row,
-- valid_until is its debut and means nothing; a status is never rewritten
-- while it holds.
create table public.character_contract_status_over_time (
  id bigint generated always as identity primary key,
  registration_id uuid not null,
  contract_id bigint not null,
  -- ESI's enum, kept as text so a new member lands rather than failing the
  -- extract: outstanding/in_progress/finished_issuer/finished_contractor/
  -- finished/cancelled/rejected/failed/deleted/reversed.
  status text not null,
  valid_from timestamptz not null,
  valid_until timestamptz not null,
  is_current boolean not null default true,
  foreign key (registration_id, contract_id)
    references public.character_contract (registration_id, contract_id) on delete cascade
);
create unique index character_contract_status_current_idx
  on public.character_contract_status_over_time (registration_id, contract_id) where is_current;
create index character_contract_status_history_idx
  on public.character_contract_status_over_time (registration_id, contract_id, valid_from);

-- ── corp_contract_status_over_time ─────────────────────────────────────────
-- The corporation mirror, keyed like corp_contract.
create table public.corp_contract_status_over_time (
  id bigint generated always as identity primary key,
  corporation_id bigint not null,
  contract_id bigint not null,
  status text not null,
  valid_from timestamptz not null,
  valid_until timestamptz not null,
  is_current boolean not null default true,
  foreign key (corporation_id, contract_id)
    references public.corp_contract (corporation_id, contract_id) on delete cascade
);
create unique index corp_contract_status_current_idx
  on public.corp_contract_status_over_time (corporation_id, contract_id) where is_current;
create index corp_contract_status_history_idx
  on public.corp_contract_status_over_time (corporation_id, contract_id, valid_from);

-- ── Backfill: each stored contract's status as its first row ───────────────
-- The only status known for an existing contract is the one it carries now.
-- It began at ESI's date for that state where there is one, else at the scan
-- that last saw it (seen_at), the earliest moment this database can vouch for.
insert into public.character_contract_status_over_time (registration_id, contract_id, status, valid_from, valid_until)
select registration_id, contract_id, status, since, since
from (
  select registration_id, contract_id, status,
         case
           when status = 'outstanding' then date_issued
           when status = 'in_progress' then coalesce(date_accepted, seen_at)
           when status in ('finished_issuer', 'finished_contractor', 'finished') then coalesce(date_completed, seen_at)
           else seen_at
         end as since
  from public.character_contract
) c;

insert into public.corp_contract_status_over_time (corporation_id, contract_id, status, valid_from, valid_until)
select corporation_id, contract_id, status, since, since
from (
  select corporation_id, contract_id, status,
         case
           when status = 'outstanding' then date_issued
           when status = 'in_progress' then coalesce(date_accepted, seen_at)
           when status in ('finished_issuer', 'finished_contractor', 'finished') then coalesce(date_completed, seen_at)
           else seen_at
         end as since
  from public.corp_contract
) c;

alter table public.character_contract drop column status;
alter table public.corp_contract drop column status;

-- ── Views ──────────────────────────────────────────────────────────────────
create view public.character_contract_status with (security_invoker = on) as
  select id, registration_id, contract_id, status, valid_from, valid_until, is_current
  from public.character_contract_status_over_time
  where is_current;

create view public.corp_contract_status with (security_invoker = on) as
  select id, corporation_id, contract_id, status, valid_from, valid_until, is_current
  from public.corp_contract_status_over_time
  where is_current;

-- The facts with the current status beside them, column for column what the
-- tables carried before the status moved out. A contract stored without a
-- status yet (a run that died between the two writes) reads as null status.
create view public.character_contract_with_status with (security_invoker = on) as
  select c.*, s.status, s.valid_from as status_since
  from public.character_contract c
  left join public.character_contract_status_over_time s
    on s.registration_id = c.registration_id and s.contract_id = c.contract_id and s.is_current;

create view public.corp_contract_with_status with (security_invoker = on) as
  select c.*, s.status, s.valid_from as status_since
  from public.corp_contract c
  left join public.corp_contract_status_over_time s
    on s.corporation_id = c.corporation_id and s.contract_id = c.contract_id and s.is_current;

-- ── Access: the same owners who read the contracts ─────────────────────────
alter table public.character_contract_status_over_time enable row level security;
create policy "Users read own contract statuses"
  on public.character_contract_status_over_time
  for select
  to authenticated
  using (
    registration_id in (
      select id from public.registration where user_id = (select auth.uid())
    )
  );

alter table public.corp_contract_status_over_time enable row level security;
create policy "Users read own corp contract statuses"
  on public.corp_contract_status_over_time
  for select
  to authenticated
  using (
    corporation_id in (
      select corporation_id from public.registration
      where user_id = (select auth.uid()) and corporation_id is not null
    )
  );

grant select on public.character_contract_status_over_time, public.corp_contract_status_over_time,
  public.character_contract_status, public.corp_contract_status,
  public.character_contract_with_status, public.corp_contract_with_status to authenticated;
grant all on public.character_contract_status_over_time, public.corp_contract_status_over_time to service_role;
grant select on public.character_contract_status, public.corp_contract_status,
  public.character_contract_with_status, public.corp_contract_with_status to service_role;

-- ── The extract's writers ──────────────────────────────────────────────────
-- Reconcile one owner's statuses against the contracts ESI just listed, in one
-- round trip. p_statuses is [{ contract_id, status, since }], `since` being
-- when the status began (contractStatus in src/jobs/contractFields.js). For
-- each listed contract:
--
--   - same status as its current row: nothing is written;
--   - a different status: the current row ends and a new one starts, both at
--     `since`, never earlier than the row being ended began;
--   - no status yet: its first row starts at `since`.
--
-- A contract ESI no longer lists (it aged out of the 30-day window) keeps its
-- last status: leaving the listing is not a change of state. Only contracts
-- whose facts are stored get a row, so the caller writes the facts first.
create or replace function public.character_contract_status_sync(p_registration_id uuid, p_statuses jsonb)
returns jsonb
language plpgsql
volatile
set search_path = public
as $$
declare
  changed integer;
  opened integer;
begin
  with incoming as (
    select distinct on ((e ->> 'contract_id')::bigint)
           (e ->> 'contract_id')::bigint as contract_id, e ->> 'status' as status, (e ->> 'since')::timestamptz as since
      from jsonb_array_elements(p_statuses) as e
  )
  update public.character_contract_status_over_time s
     set is_current = false,
         valid_until = greatest(i.since, s.valid_from)
    from incoming i
   where s.registration_id = p_registration_id
     and s.contract_id = i.contract_id
     and s.is_current
     and s.status <> i.status;
  get diagnostics changed = row_count;

  with incoming as (
    select distinct on ((e ->> 'contract_id')::bigint)
           (e ->> 'contract_id')::bigint as contract_id, e ->> 'status' as status, (e ->> 'since')::timestamptz as since
      from jsonb_array_elements(p_statuses) as e
  )
  insert into public.character_contract_status_over_time (registration_id, contract_id, status, valid_from, valid_until)
  select p_registration_id, i.contract_id, i.status, starts.at, starts.at
    from incoming i
    join public.character_contract c on c.registration_id = p_registration_id and c.contract_id = i.contract_id
    cross join lateral (
      select greatest(i.since, coalesce(max(p.valid_until), i.since)) as at
        from public.character_contract_status_over_time p
       where p.registration_id = p_registration_id and p.contract_id = i.contract_id and not p.is_current
    ) starts
   where not exists (
     select 1 from public.character_contract_status_over_time s
      where s.registration_id = p_registration_id and s.contract_id = i.contract_id and s.is_current
   );
  get diagnostics opened = row_count;

  return jsonb_build_object('changed', changed, 'opened', opened);
end;
$$;

create or replace function public.corp_contract_status_sync(p_corporation_id bigint, p_statuses jsonb)
returns jsonb
language plpgsql
volatile
set search_path = public
as $$
declare
  changed integer;
  opened integer;
begin
  with incoming as (
    select distinct on ((e ->> 'contract_id')::bigint)
           (e ->> 'contract_id')::bigint as contract_id, e ->> 'status' as status, (e ->> 'since')::timestamptz as since
      from jsonb_array_elements(p_statuses) as e
  )
  update public.corp_contract_status_over_time s
     set is_current = false,
         valid_until = greatest(i.since, s.valid_from)
    from incoming i
   where s.corporation_id = p_corporation_id
     and s.contract_id = i.contract_id
     and s.is_current
     and s.status <> i.status;
  get diagnostics changed = row_count;

  with incoming as (
    select distinct on ((e ->> 'contract_id')::bigint)
           (e ->> 'contract_id')::bigint as contract_id, e ->> 'status' as status, (e ->> 'since')::timestamptz as since
      from jsonb_array_elements(p_statuses) as e
  )
  insert into public.corp_contract_status_over_time (corporation_id, contract_id, status, valid_from, valid_until)
  select p_corporation_id, i.contract_id, i.status, starts.at, starts.at
    from incoming i
    join public.corp_contract c on c.corporation_id = p_corporation_id and c.contract_id = i.contract_id
    cross join lateral (
      select greatest(i.since, coalesce(max(p.valid_until), i.since)) as at
        from public.corp_contract_status_over_time p
       where p.corporation_id = p_corporation_id and p.contract_id = i.contract_id and not p.is_current
    ) starts
   where not exists (
     select 1 from public.corp_contract_status_over_time s
      where s.corporation_id = p_corporation_id and s.contract_id = i.contract_id and s.is_current
   );
  get diagnostics opened = row_count;

  return jsonb_build_object('changed', changed, 'opened', opened);
end;
$$;

-- Service role only: every public function is executable by anon and
-- authenticated by default, and these write.
revoke execute on function public.character_contract_status_sync(uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.corp_contract_status_sync(bigint, jsonb) from public, anon, authenticated;
grant execute on function public.character_contract_status_sync(uuid, jsonb) to service_role;
grant execute on function public.corp_contract_status_sync(bigint, jsonb) to service_role;
