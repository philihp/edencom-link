-- The write the mail auto-responder makes for a mail's sender
-- (docs/ship-memory.md "Speaking for a mail's sender"): item_memory_write()
-- for one EVE character named by its id rather than for the session's user.
-- The MCP tool reads the character from the sender of a mail in the caller's
-- own mail copy, which EVE sets and nobody can fake, and calls this on the
-- service role, where auth.uid() is null and holds_item() is false.
--
-- The holder test is holds_item()'s, narrowed to the one character: the
-- item's one current asset row belongs to a registration of that character,
-- or to the corporation a registration of that character is in. Not an alt
-- of the same account, and not a share recipient. The account of that
-- registration is the writer (written_by, and closed_by on the version it
-- supersedes), so the sender reads what was written for them the way they
-- read their own writes. Not held, or no registration of the character, is
-- 42501; a stale p_based_on is PT409, as in item_memory_write().
--
-- Service role only: it trusts p_character_id, so nobody else may call it.
create or replace function public.item_memory_write_for_character(
  p_character_id bigint,
  p_item_id bigint,
  p_body text,
  p_based_on bigint,
  p_author text default 'mail'
)
returns bigint
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user_id uuid;
  v_type_id bigint;
  v_closed  bigint;
  v_id      bigint;
begin
  -- One current asset row across both hangars, so at most one branch matches.
  select r.user_id, v.type_id into v_user_id, v_type_id
  from public.character_asset_version v
  join public.registration r on r.id = v.registration_id
  where v.item_id = p_item_id and v.is_current and r.character_id = p_character_id
  limit 1;

  if v_user_id is null then
    select r.user_id, v.type_id into v_user_id, v_type_id
    from public.corp_asset_version v
    join public.registration r on r.corporation_id = v.corporation_id
    where v.item_id = p_item_id and v.is_current and r.character_id = p_character_id
    order by r.updated_at desc, r.id
    limit 1;
  end if;

  if v_user_id is null then
    raise exception 'item % is not held by character %', p_item_id, p_character_id
      using errcode = '42501',
            hint = 'Only the character, or the corporation of the character, holding an item writes its memory.';
  end if;

  if p_based_on is null then
    if exists (select 1 from public.item_memory_over_time where item_id = p_item_id and is_current) then
      raise exception 'item % already has a memory', p_item_id
        using errcode = 'PT409',
              hint = 'Read the current version and pass its id as based_on.';
    end if;
  else
    update public.item_memory_over_time
       set is_current = false, valid_until = now(), closed_by = v_user_id
     where id = p_based_on and item_id = p_item_id and is_current
    returning id into v_closed;
    if v_closed is null then
      raise exception 'the memory of item % changed since version % was read', p_item_id, p_based_on
        using errcode = 'PT409',
              hint = 'Read the current version again and write on top of it.';
    end if;
  end if;

  begin
    insert into public.item_memory_over_time (item_id, type_id, body, author, written_by)
    values (p_item_id, v_type_id, p_body, coalesce(nullif(btrim(p_author), ''), 'mail'), v_user_id)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'item % already has a memory', p_item_id
      using errcode = 'PT409',
            hint = 'Another write landed first. Read the current version and write on top of it.';
  end;

  return v_id;
end;
$$;

revoke execute on function public.item_memory_write_for_character(bigint, bigint, text, bigint, text)
  from public, anon, authenticated;
grant execute on function public.item_memory_write_for_character(bigint, bigint, text, bigint, text)
  to service_role;
