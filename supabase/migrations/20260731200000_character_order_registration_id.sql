-- Rename character_order_over_time.character_id to registration_id — third
-- tranche of step 5 of docs/registration-id-rename.md.
--
-- This is the first family in the migration where a SQL function has to move
-- with the table, which is why it gets a PR to itself rather than joining the
-- ship/skill/clone batch in #757.
--
-- character_orders() is a classic string-body SQL function: its body is stored
-- as text and re-parsed at execution, so after the rename it would still name
-- o.character_id and fail at the *next call* — the /api/character/orders Sheets
-- endpoint and the MCP list_market_orders as_of path — with nothing failing
-- here to warn us. It has to be recreated in the same migration as the rename.
--
-- CREATE OR REPLACE is enough for it, unlike latest_heartbeats() in #754. What
-- forced a drop there was renaming a RETURNS TABLE column, which is a
-- return-type change; this function returns plain json and keeps its exact
-- signature, so only the body moves. Note in particular that the *parameter*
-- stays character_ids: renaming it is step 7, it has to ship in lockstep with
-- every RPC call site (supabase-js passes arguments by name), and folding that
-- in here would widen this PR into eight functions and ~11 call sites.
--
-- So the two senses sit side by side inside the recreated body for now —
-- `where o.registration_id = any(character_ids)` — which reads oddly on
-- purpose, exactly like the `character_id: registration_id` payloads step 2
-- left behind. Step 7 is what retires it.

alter table public.character_order_over_time rename column character_id to registration_id;

alter index if exists public.character_order_over_time_character_id_idx
  rename to character_order_over_time_registration_id_idx;

-- `select *` froze this view's output names at creation, so it would keep
-- publishing character_id; CREATE OR REPLACE VIEW cannot rename them either.
drop view if exists public.character_order;
create view public.character_order with (security_invoker = on) as
  select * from public.character_order_over_time where is_current;
grant select on public.character_order to authenticated;

create or replace function public.character_orders(character_ids uuid[], as_of timestamptz default now())
returns json
language sql
stable
as $$
  select coalesce(
    json_agg(
      json_build_object(
        'duration',       o.duration,
        'escrow',         o.escrow,
        'is_buy_order',   o.is_buy,
        'is_corporation', o.is_corporation,
        'issued',         o.issued,
        'location_id',    o.location_id,
        'min_volume',     o.min_volume,
        'order_id',       o.order_id,
        'price',          o.price,
        'range',          o.range,
        'region_id',      o.region_id,
        'type_id',        o.type_id,
        'volume_remain',  o.volume_remain,
        'volume_total',   o.volume_total,
        'character_name', r.name,
        'type_name',      t.name
      )
      order by o.issued desc
    ),
    '[]'::json
  )
  from public.character_order_over_time o
  join public.registration r on r.id = o.registration_id
  left join public.sde_published_type t on t.type_id = o.type_id
  where o.registration_id = any(character_ids)
    and o.valid_from <= as_of
    and (o.is_current or o.valid_until >= as_of);
$$;

grant execute on function public.character_orders(uuid[], timestamptz) to service_role;

-- Assert both dependents, since neither failure would be visible in a diff.
--
-- The function check is the one that matters: a string-body function still
-- naming the old column parses fine at CREATE time and only fails when called,
-- so without this the migration would go green and the Sheets endpoint would
-- start 500ing on the next refresh. Probing pg_get_functiondef catches a body
-- that didn't get updated — including the case where this whole statement was
-- accidentally left out of a future copy of this migration.
do $$
declare
  def text;
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'character_order'
      and column_name = 'character_id'
  ) then
    raise exception 'view character_order still publishes character_id after the rename';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'character_order'
      and column_name = 'registration_id'
  ) then
    raise exception 'view character_order does not publish registration_id';
  end if;

  select pg_get_functiondef(p.oid) into def
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'character_orders';

  if def is null then
    raise exception 'function public.character_orders() is missing after the rename';
  end if;
  if def like '%o.character_id%' then
    raise exception
      'character_orders() body still references o.character_id — it would fail at its next call, not here';
  end if;
  if def not like '%o.registration_id%' then
    raise exception 'character_orders() body does not reference o.registration_id';
  end if;
end $$;
