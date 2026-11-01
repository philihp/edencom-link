-- Ship memory storage (docs/ship-memory.md, PR 2): one markdown text an item
-- keeps about itself, written by the player's AI companion over MCP in the
-- ship's own voice and rewritten as its history grows. Every version is kept.
--
-- The memory belongs to the hull, not to an account. It is keyed on item_id,
-- which EVE never reuses and a hull keeps through every trade, so the memory
-- passes to a buyer. Edit rights follow the one current asset row across both
-- hangar tables (migration 20261101065555_asset_claim_cross_hangar), tested by
-- holds_item() below. Nothing writes here yet: remember_ship (PR 4) calls
-- item_memory_write(), and the reassembly carry (PR 6) adds
-- carried_from_item_id and writes on the service role.

create table public.item_memory_over_time (
  id bigint generated always as identity primary key,
  -- No foreign key: a memory outlives the asset row. A dead hull's memory
  -- stays on its id, and the share page of a dead hull still draws it.
  item_id bigint not null,
  -- Provenance only; it grants no write access. It lets an author keep reading
  -- what they wrote after the hull is sold. A deleted account leaves the text
  -- with the hull (set null), not a hole in the ship's history.
  written_by uuid default auth.uid() references auth.users (id) on delete set null,
  -- Who superseded this version. The RLS read policy needs it: Postgres checks
  -- an UPDATE's new row against the SELECT policy, so a buyer closing the
  -- seller's version must still be able to read it afterwards. That reveals
  -- nothing new, since the closer read it as the current text a moment before.
  closed_by uuid references auth.users (id) on delete set null,
  -- The type at write time, so a dead hull's memory still knows what it was.
  type_id bigint not null,
  body text not null check (char_length(btrim(body)) > 0 and char_length(body) <= 20000),
  -- The MCP client's name where the protocol supplies one, else 'mcp'.
  author text not null default 'mcp' check (char_length(author) between 1 and 200),
  is_current boolean not null default true,
  valid_from timestamptz not null default now(),
  -- As on the asset tables, an open row's valid_until means nothing (it is
  -- stamped at the insert); the close sets it to the moment it was superseded.
  valid_until timestamptz not null default now()
);

-- One current memory per item, and the guard item_memory_write() leans on
-- when two first writes race.
create unique index item_memory_over_time_current_idx
  on public.item_memory_over_time (item_id) where is_current;
-- An item's versions, newest first ("written N times, last on …").
create index item_memory_over_time_item_idx
  on public.item_memory_over_time (item_id, valid_from desc);
-- The two account branches of the read policy, and the set-null cascades.
create index item_memory_over_time_written_by_idx
  on public.item_memory_over_time (written_by);
create index item_memory_over_time_closed_by_idx
  on public.item_memory_over_time (closed_by);

create view public.item_memory with (security_invoker = on) as
  select * from public.item_memory_over_time where is_current;

-- Does the caller hold this item now? True when its one current asset row
-- (one across both hangars) belongs to one of the caller's registrations or to
-- a corporation the caller has a character in. Seeing a row is not holding
-- it: character_asset_version also shows a share recipient the rows shared
-- with them, so the owner is tested explicitly rather than left to RLS.
-- Invoker rights; safe to call from a policy on any table but the two asset
-- tables themselves.
create or replace function public.holds_item(item bigint)
returns boolean
language sql
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.character_asset_version v
    where v.item_id = item
      and v.is_current
      and v.registration_id in (
        select id from public.registration where user_id = (select auth.uid())
      )
  )
  or exists (
    select 1
    from public.corp_asset_version v
    where v.item_id = item
      and v.is_current
      and v.corporation_id in (select public.my_corporation_ids())
  );
$$;

grant execute on function public.holds_item(bigint) to authenticated, service_role;

alter table public.item_memory_over_time enable row level security;

-- The holder reads the current text, including what earlier owners wrote,
-- since that is what the ship remembers. Every author keeps their own
-- versions, and every closer the versions they superseded. A former owner's
-- superseded versions are never shown to the next holder, so a part a seller
-- dropped before selling stays dropped.
create policy "Holders, authors and closers read item memories"
  on public.item_memory_over_time
  for select
  to authenticated
  using (
    written_by = (select auth.uid())
    or closed_by = (select auth.uid())
    or (is_current and public.holds_item(item_id))
  );

create policy "Holders add a current version"
  on public.item_memory_over_time
  for insert
  to authenticated
  with check (written_by = (select auth.uid()) and is_current and public.holds_item(item_id));

-- Closing is the only update: a holder may supersede the current version, and
-- nothing else. A closed row is never touched again.
create policy "Holders close the current version"
  on public.item_memory_over_time
  for update
  to authenticated
  using (is_current and public.holds_item(item_id))
  with check (not is_current and closed_by = (select auth.uid()));

-- RLS is the gate. The column grants keep a direct write to the shape
-- item_memory_write() makes: an insert cannot set its author account, its
-- version flag or its timestamps, and an update can only close. So what a
-- holder can do without the function is what they can do with it, less the
-- check that they read the version they replace. No delete, no anon.
revoke all on public.item_memory_over_time from anon, authenticated;
grant select on public.item_memory_over_time to authenticated;
grant insert (item_id, type_id, body, author) on public.item_memory_over_time to authenticated;
grant update (is_current, valid_until, closed_by) on public.item_memory_over_time to authenticated;
grant all on public.item_memory_over_time to service_role;

revoke all on public.item_memory from anon, authenticated;
grant select on public.item_memory to authenticated, service_role;

-- The one way remember_ship writes: close the current version and open the
-- next in one transaction, which two PostgREST calls cannot do. Returns the
-- new version's id, the based_on of the next write.
--
-- p_based_on is the version the caller read: the current version's id, or
-- null when there is no memory yet. Anything else is a stale write, refused
-- with SQLSTATE PT409 (PostgREST answers 409), so two conversations writing
-- one ship, or two members of the corporation holding it, never silently
-- overwrite each other. An item the caller does not hold is 42501.
--
-- Invoker rights: every write below goes through the policies above, so the
-- function grants nothing a holder lacks. A racing close is serialized by the
-- row lock (the loser re-reads is_current as false and closes nothing), and
-- two racing first writes by the unique index.
create or replace function public.item_memory_write(
  p_item_id bigint,
  p_body text,
  p_based_on bigint,
  p_author text default 'mcp'
)
returns bigint
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_type_id bigint;
  v_closed  bigint;
  v_id      bigint;
begin
  if not public.holds_item(p_item_id) then
    raise exception 'item % is not held by the caller', p_item_id
      using errcode = '42501',
            hint = 'Only the character or corporation holding an item writes its memory.';
  end if;

  -- One current asset row across both hangars, so at most one of these is set.
  v_type_id := coalesce(
    (select type_id from public.character_asset_version where item_id = p_item_id and is_current),
    (select type_id from public.corp_asset_version where item_id = p_item_id and is_current)
  );

  if p_based_on is null then
    if exists (select 1 from public.item_memory_over_time where item_id = p_item_id and is_current) then
      raise exception 'item % already has a memory', p_item_id
        using errcode = 'PT409',
              hint = 'Read the current version and pass its id as based_on.';
    end if;
  else
    update public.item_memory_over_time
       set is_current = false, valid_until = now(), closed_by = (select auth.uid())
     where id = p_based_on and item_id = p_item_id and is_current
    returning id into v_closed;
    if v_closed is null then
      raise exception 'the memory of item % changed since version % was read', p_item_id, p_based_on
        using errcode = 'PT409',
              hint = 'Read the current version again and write on top of it.';
    end if;
  end if;

  begin
    insert into public.item_memory_over_time (item_id, type_id, body, author)
    values (p_item_id, v_type_id, p_body, coalesce(nullif(btrim(p_author), ''), 'mcp'))
    returning id into v_id;
  exception when unique_violation then
    raise exception 'item % already has a memory', p_item_id
      using errcode = 'PT409',
            hint = 'Another write landed first. Read the current version and write on top of it.';
  end;

  return v_id;
end;
$$;

revoke execute on function public.item_memory_write(bigint, text, bigint, text) from public, anon;
grant execute on function public.item_memory_write(bigint, text, bigint, text) to authenticated, service_role;
