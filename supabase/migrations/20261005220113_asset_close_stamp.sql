-- The asset reconciles no longer touch unchanged rows (every unchanged item's
-- valid_until was moved forward each run — ~200 index-writing updates per real
-- change, the whole write load of character_asset_version). A row is now
-- written only when it changes or vanishes, and a close stamps valid_until
-- with the run's clock. The two claim functions do the cross-owner close for
-- an item changing hands; this makes them stamp it too, with the clock the
-- caller sent on the rows (every payload row carries valid_until), so a ship
-- and what was aboard it close on one instant however the chunks fell. Only a
-- payload without a stamp falls back to now().
--
-- An open row's valid_until is now its debut and means nothing; "last seen"
-- for an item still held is the owner's latest character-assets /
-- corp-assets heartbeat (src/app/ship/[itemId]/sharedShip.ts). Every other
-- reader of valid_until tests is_current first (the time-travel predicate, the
-- best-known-parent CTEs, the share page's newest-version lookup), so none of
-- them see the difference. Bodies otherwise identical to schema.sql.

create or replace function public.character_asset_claim(p_rows jsonb)
returns integer
language plpgsql
security invoker
set search_path to 'public'
as $$
declare
  v_items    bigint[];
  v_ids      bigint[];
  v_now      timestamptz;
  v_inserted integer;
begin
  if p_rows is null or jsonb_array_length(p_rows) = 0 then
    return 0;
  end if;

  select array_agg(distinct (r->>'item_id')::bigint),
         coalesce(min((r->>'valid_until')::timestamptz), now())
    into v_items, v_now
    from jsonb_array_elements(p_rows) r;

  perform pg_advisory_xact_lock(hashtext('public.character_asset_over_time')::bigint);

  -- The run's clock, carried on every row as valid_until: the close below
  -- stamps the previous owner's row with it, so a ship and what was aboard
  -- it, claimed in different chunks, still close on one instant — which is
  -- what the share page's last-known-contents query compares. Only when a
  -- caller sends no stamp does the database clock stand in.
  update public.character_asset_version
     set is_current = false, valid_until = v_now
   where is_current
     and item_id = any (v_items);

  with inserted as (
    insert into public.character_asset_version
      (item_id, registration_id, type_id, location_id, location_flag, location_type,
       quantity, is_singleton, is_blueprint_copy, valid_until, name)
    select (r->>'item_id')::bigint,
           (r->>'registration_id')::uuid,
           (r->>'type_id')::bigint,
           (r->>'location_id')::bigint,
           r->>'location_flag',
           r->>'location_type',
           (r->>'quantity')::bigint,
           (r->>'is_singleton')::boolean,
           coalesce((r->>'is_blueprint_copy')::boolean, false),
           coalesce((r->>'valid_until')::timestamptz, now()),
           r->>'name'
      from jsonb_array_elements(p_rows) r
    returning id
  )
  select array_agg(id) into v_ids from inserted;
  v_inserted := coalesce(array_length(v_ids, 1), 0);

  -- Move each new root item's place into the owner-only table.
  insert into public.character_asset_location (asset_id, registration_id, location_id, location_flag, location_type)
  select v.id, v.registration_id, v.location_id, v.location_flag, v.location_type
    from public.character_asset_version v
   where v.id = any (v_ids)
     and v.location_id is not null
     and not exists (
       select 1
         from public.character_asset_version p
        where p.is_current
          and p.item_id = v.location_id
          and p.registration_id = v.registration_id
     );

  update public.character_asset_version v
     set location_id = null, location_flag = null, location_type = null
    from public.character_asset_location l
   where l.asset_id = v.id
     and v.id = any (v_ids);

  -- A child that arrived before its parent — in an earlier chunk of this run
  -- (the extract claims 1000 rows at a time, in ESI's order) or in an earlier
  -- run — found no open parent row and filed the parent's item id as its
  -- place. Now that the parent is an open item of the same owner, it is a
  -- parent link again: back onto the version row, out of the place table.
  -- Without this the share walk could not climb through it, and a recipient
  -- would not see that child. Keyed on the items this call inserted, so it is
  -- one indexed probe per new item rather than a sweep.
  with relinked as (
    delete from public.character_asset_location l
     using public.character_asset_version c, public.character_asset_version p
     where c.id = l.asset_id
       and c.is_current
       and p.is_current
       and p.item_id = l.location_id
       and p.registration_id = l.registration_id
       and p.item_id = any (v_items)
    returning l.asset_id, l.location_id, l.location_flag, l.location_type
  )
  update public.character_asset_version v
     set location_id = r.location_id, location_flag = r.location_flag, location_type = r.location_type
    from relinked r
   where v.id = r.asset_id;

  return v_inserted;
end
$$;

revoke execute on function public.character_asset_claim(jsonb) from public, anon, authenticated;
grant execute on function public.character_asset_claim(jsonb) to service_role;

create or replace function public.corp_asset_claim(p_rows jsonb)
returns integer
language plpgsql
security invoker
set search_path to 'public'
as $$
declare
  v_items    bigint[];
  v_now      timestamptz;
  v_inserted integer;
begin
  if p_rows is null or jsonb_array_length(p_rows) = 0 then
    return 0;
  end if;

  select array_agg(distinct (r->>'item_id')::bigint),
         coalesce(min((r->>'valid_until')::timestamptz), now())
    into v_items, v_now
    from jsonb_array_elements(p_rows) r;

  perform pg_advisory_xact_lock(hashtext('public.corp_asset_over_time')::bigint);

  -- The run's clock, carried on every row as valid_until: the close below
  -- stamps the previous owner's row with it, so a ship and what was aboard
  -- it, claimed in different chunks, still close on one instant — which is
  -- what the character twin's share page compares. Only when a
  -- caller sends no stamp does the database clock stand in.
  update public.corp_asset_over_time
     set is_current = false, valid_until = v_now
   where is_current
     and item_id = any (v_items);

  insert into public.corp_asset_over_time
    (item_id, corporation_id, type_id, location_id, location_flag, location_type,
     quantity, is_singleton, is_blueprint_copy, valid_until)
  select (r->>'item_id')::bigint,
         (r->>'corporation_id')::bigint,
         (r->>'type_id')::bigint,
         (r->>'location_id')::bigint,
         r->>'location_flag',
         r->>'location_type',
         (r->>'quantity')::bigint,
         (r->>'is_singleton')::boolean,
         coalesce((r->>'is_blueprint_copy')::boolean, false),
         coalesce((r->>'valid_until')::timestamptz, now())
    from jsonb_array_elements(p_rows) r;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end
$$;

revoke execute on function public.corp_asset_claim(jsonb) from public, anon, authenticated;
grant execute on function public.corp_asset_claim(jsonb) to service_role;
