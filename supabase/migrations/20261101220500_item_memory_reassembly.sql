-- Ship memory, reassembly (docs/ship-memory.md, "Reassembly", PR 6): a
-- repackaged hull's memory goes back into the hull assembled from it,
-- wherever the asset extract can tie the two together.
--
-- Three pieces:
--
--   * carried_from_item_id on item_memory_over_time: set on the first version
--     under a reassembled hull's new id, naming the id it was carried from.
--     Chained, it is the ship's lineage across every repackaging, and the
--     dossier walks it so the itinerary covers the ship's whole life. A
--     trigger copies it forward onto every later version of the same item,
--     so the holder always reads the pointer on the current row, without any
--     new column grant: a direct write still cannot name it.
--   * item_memory_pack: a hull with a memory vanished, and a packaged stack of
--     its type at the same place appeared or grew in the same run. The row
--     holds the memory's claim until a hull of that type is assembled again.
--     Written by the service role from the two asset extracts; the owner
--     reads their own pending rows, which is how recall_ship lists the
--     candidates of an ambiguous reassembly.
--   * item_memory_carry(): the carry itself, in one transaction on the
--     service role: open a version under the new id with the old body and
--     the old author account, close the old id's current version, mark the
--     pack resolved. Nothing is deleted, and a superseded version on the old
--     id stays with its author.

-- ── the lineage pointer ───────────────────────────────────────────────────

alter table public.item_memory_over_time
  add column carried_from_item_id bigint;

comment on column public.item_memory_over_time.carried_from_item_id is
  'The item id this memory was carried from at a reassembly; copied onto every later version of the item.';

-- A version that supersedes another keeps its lineage pointer, so the current
-- row always says where the memory came from. The version just closed is
-- readable to the writer under RLS (closed_by is them), so this runs with the
-- caller's rights and reads nothing they could not. A row that names its
-- own pointer (the carry) keeps it.
create or replace function public.item_memory_inherit_lineage()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.carried_from_item_id is null then
    select m.carried_from_item_id into new.carried_from_item_id
    from public.item_memory_over_time m
    where m.item_id = new.item_id and not m.is_current
    order by m.valid_until desc, m.id desc
    limit 1;
  end if;
  return new;
end;
$$;

create trigger item_memory_inherit_lineage
  before insert on public.item_memory_over_time
  for each row execute function public.item_memory_inherit_lineage();

-- Re-expand the view's column list.
create or replace view public.item_memory with (security_invoker = on) as
  select * from public.item_memory_over_time where is_current;

-- ── item_memory_pack ──────────────────────────────────────────────────────

create table public.item_memory_pack (
  id bigint generated always as identity primary key,
  -- The hull that vanished, whose memory waits here. No foreign key: its
  -- asset row is closed and its memory outlives it.
  item_id bigint not null,
  type_id bigint not null,
  -- Exactly one owner: the registration or the corporation whose hangar the
  -- hull left, folded into owner_key the way structure_tenant does.
  registration_id uuid references public.registration (id) on delete cascade,
  corporation_id  bigint,
  owner_key text generated always as (coalesce(registration_id::text, 'corp:' || corporation_id::text)) stored,
  -- The packaged stack that took the hull, when one stack did. Null when
  -- several stacks of the type grew at that place in the run, in which case
  -- only the place can find the hull again.
  stack_item_id bigint,
  -- The place as the extract saw it: a station, a structure or the parent
  -- item, the same id the hull's and the stacks' rows carry.
  location_id bigint,
  packed_at timestamptz not null,
  -- Set once by item_memory_carry(): when the memory moved on, and to which hull.
  resolved_at timestamptz,
  resolved_item_id bigint,
  check ((registration_id is null) <> (corporation_id is null)),
  check ((resolved_at is null) = (resolved_item_id is null))
);

-- The pending rows an owner's run and recall_ship ask for.
create index item_memory_pack_pending_owner_idx
  on public.item_memory_pack (owner_key) where resolved_at is null;
-- Rule 2: a pending pack by the stack it went into, under any owner.
create index item_memory_pack_pending_stack_idx
  on public.item_memory_pack (stack_item_id) where resolved_at is null and stack_item_id is not null;
create index item_memory_pack_item_idx
  on public.item_memory_pack (item_id);

alter table public.item_memory_pack enable row level security;

-- An owner reads their own packs: a character's through its registration, a
-- corporation's through membership. Nobody else learns that a hull was ever
-- repackaged.
create policy "Owners read own memory packs"
  on public.item_memory_pack
  for select
  to authenticated
  using (
    registration_id in (select id from public.registration where user_id = (select auth.uid()))
    or corporation_id in (select public.my_corporation_ids())
  );

revoke all on public.item_memory_pack from anon, authenticated;
grant select on public.item_memory_pack to authenticated;
grant all    on public.item_memory_pack to service_role;

-- ── the carry ─────────────────────────────────────────────────────────────

-- Carry the memory of p_from_item_id onto p_to_item_id, and resolve the pack
-- that waited for it (none for a hull repackaged and reassembled between two
-- extracts). Service role only: the asset extracts call it after a
-- reconcile, and remember_ship's inherit_from calls it after checking the
-- caller holds the new hull and owns the pack. The new version keeps the old
-- one's written_by (the author's own reading rights follow their text) and
-- is signed author = 'reassembly'; the old id's current version is closed by
-- nobody, since no account did it. Returns the new version's id.
--
-- Refused when the old id has no current memory, when the new hull already
-- has one (the memory of a hull that exists is never overwritten by a
-- carry), when the new hull has no current asset row, when its type differs
-- from the memory's, or when the pack is not pending.
create or replace function public.item_memory_carry(
  p_from_item_id bigint,
  p_to_item_id bigint,
  p_pack_id bigint default null
)
returns bigint
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_old     public.item_memory_over_time;
  v_type_id bigint;
  v_id      bigint;
  v_now     timestamptz := now();
begin
  if p_from_item_id = p_to_item_id then
    raise exception 'a memory cannot be carried onto its own item (%)', p_to_item_id
      using errcode = '22023';
  end if;

  select * into v_old
  from public.item_memory_over_time
  where item_id = p_from_item_id and is_current
  for update;
  if v_old.id is null then
    raise exception 'item % has no current memory to carry', p_from_item_id
      using errcode = 'P0002';
  end if;

  if exists (select 1 from public.item_memory_over_time where item_id = p_to_item_id and is_current) then
    raise exception 'item % already has a memory', p_to_item_id
      using errcode = 'PT409',
            hint = 'A carry never overwrites the memory of a hull that has one.';
  end if;

  -- One current asset row across both hangars.
  v_type_id := coalesce(
    (select type_id from public.character_asset_version where item_id = p_to_item_id and is_current),
    (select type_id from public.corp_asset_version where item_id = p_to_item_id and is_current)
  );
  if v_type_id is null then
    raise exception 'item % is not held by anyone', p_to_item_id
      using errcode = 'P0002';
  end if;
  if v_type_id <> v_old.type_id then
    raise exception 'item % is type %, and the memory of item % belongs to type %',
      p_to_item_id, v_type_id, p_from_item_id, v_old.type_id
      using errcode = '22023';
  end if;

  if p_pack_id is not null then
    update public.item_memory_pack
       set resolved_at = v_now, resolved_item_id = p_to_item_id
     where id = p_pack_id and item_id = p_from_item_id and resolved_at is null;
    if not found then
      raise exception 'pack % is not a pending pack of item %', p_pack_id, p_from_item_id
        using errcode = 'P0002';
    end if;
  end if;

  update public.item_memory_over_time
     set is_current = false, valid_until = v_now
   where id = v_old.id;

  insert into public.item_memory_over_time
    (item_id, type_id, body, author, written_by, carried_from_item_id, valid_from, valid_until)
  values
    (p_to_item_id, v_old.type_id, v_old.body, 'reassembly', v_old.written_by, p_from_item_id, v_now, v_now)
  returning id into v_id;

  return v_id;
end;
$$;

revoke execute on function public.item_memory_carry(bigint, bigint, bigint) from public, anon, authenticated;
grant execute on function public.item_memory_carry(bigint, bigint, bigint) to service_role;

-- PostgREST learns the new table and function on its next schema reload.
notify pgrst, 'reload schema';
