-- asset_value_day: what each owner's hangar was worth, one row per UTC day,
-- for the valuation chart on the /asset landing page (docs/asset-valuation.md).
--
-- Every item is priced at the Jita split (the midpoint of best bid and best
-- ask, the same price /industry's lift uses) in effect at the row's moment,
-- never today's price, so a day's value is what the hangar was worth that day.
-- Blueprints are left out: a copy has no market, and an original's market
-- price says nothing about its research.
--
-- Written by asset_value_day_compute(), which the two asset extracts call for
-- today after each reconcile (src/jobs/assetValues.js), and which the
-- `pnpm run asset-values` backfill calls for every earlier day that has
-- prices on record. Recompute, never increment: a re-run of a day replaces it.

create table public.asset_value_day (
  -- Exactly one owner key (structure_measure_day's shape).
  registration_id uuid references public.registration (id) on delete cascade,
  corporation_id  bigint,
  utc_day         date not null,
  -- The moment the holdings and prices were read at: the end of the day for a
  -- past day, the extract's run for today.
  as_of           timestamptz not null,
  -- Units × Jita split, summed over every priced type.
  value           numeric(20, 2) not null default 0,
  priced_types    integer not null default 0,
  -- Types held that had no price at that moment (none captured yet, or an
  -- empty book). Left out of `value`, so the page can say the value is a floor.
  unpriced_types  integer not null default 0,
  unpriced_units  bigint not null default 0,
  computed_at     timestamptz not null default now(),
  owner_key text generated always as (coalesce(registration_id::text, 'corp:' || corporation_id::text)) stored,
  check ((registration_id is null) <> (corporation_id is null)),
  primary key (owner_key, utc_day)
);
-- The page reads a window of days for each owner it can see.
create index asset_value_day_registration_idx on public.asset_value_day (registration_id, utc_day desc);
create index asset_value_day_corporation_idx  on public.asset_value_day (corporation_id, utc_day desc);

alter table public.asset_value_day enable row level security;
-- Own rows only, on the predicates the asset tables use for ownership: a
-- registration's through the account, a corporation's through membership.
create policy "Users read own asset values"
  on public.asset_value_day
  for select
  to authenticated
  using (
    registration_id in (
      select id from public.registration where user_id = (select auth.uid())
    )
    or corporation_id in (select public.my_corporation_ids())
  );

grant select on public.asset_value_day to authenticated;
grant all    on public.asset_value_day to service_role;

-- Compute and store one owner's value for each UTC day in [p_from, p_to].
-- Returns how many days it wrote.
--
-- A day is skipped when no Jita price is on record at its moment at all
-- (probed through Tritanium, which every capture carries, on the per-type
-- btree — finding the first capture over the whole table is a full scan).
-- Without that, a day before the price record began would store a zero and
-- the chart would show a crash that never happened.
--
-- What the owner held at a moment: for each item, its latest version that had
-- begun by then, kept when it is still current, or was not yet closed, or has
-- a later version (the item was still held, in some other state). The last
-- test covers the versions closed before 2026-10, whose valid_until was the
-- last sighting rather than the close. Today is the plain current snapshot.
--
-- Service role only. force_custom_plan, so the owner branch that does not
-- apply is pruned as a constant rather than kept in a generic plan.
create or replace function public.asset_value_day_compute(
  p_registration_id uuid,
  p_corporation_id  bigint,
  p_from            date,
  p_to              date
)
returns integer
language plpgsql
set search_path to 'public'
set plan_cache_mode to 'force_custom_plan'
as $$
declare
  v_today   date := (now() at time zone 'utc')::date;
  v_day     date;
  v_at      timestamptz;
  v_live    boolean;
  v_written integer := 0;
begin
  if (p_registration_id is null) = (p_corporation_id is null) then
    raise exception 'asset_value_day_compute: name exactly one owner' using errcode = '22023';
  end if;

  for v_day in
    select d::date from generate_series(p_from, least(p_to, v_today), interval '1 day') d
  loop
    v_live := v_day = v_today;
    v_at := case when v_live then now() else (v_day + 1)::timestamp at time zone 'utc' end;

    continue when not exists (
      select 1 from public.market_price_over_time
       where market = 'jita' and type_id = 34 and valid_from <= v_at
    );

    with versions as (
      select distinct on (v.item_id) v.item_id, v.type_id, v.quantity, v.is_current, v.valid_until
        from (
          select item_id, type_id, quantity, is_current, valid_from, valid_until
            from public.character_asset_version
           where p_registration_id is not null
             and registration_id = p_registration_id
             and valid_from <= v_at
             and (is_current or not v_live)
          union all
          select item_id, type_id, quantity, is_current, valid_from, valid_until
            from public.corp_asset_version
           where p_corporation_id is not null
             and corporation_id = p_corporation_id
             and valid_from <= v_at
             and (is_current or not v_live)
        ) v
       order by v.item_id, v.valid_from desc
    ),
    held as (
      select h.type_id, sum(coalesce(h.quantity, 1))::bigint as units
        from versions h
       where h.is_current
          or h.valid_until > v_at
          or exists (select 1 from public.character_asset_version n where n.item_id = h.item_id and n.valid_from > v_at)
          or exists (select 1 from public.corp_asset_version n where n.item_id = h.item_id and n.valid_from > v_at)
       group by h.type_id
    ),
    priced as (
      select h.units,
             case
               when p.buy_max is null then p.sell_min
               when p.sell_min is null then p.buy_max
               else (p.buy_max + p.sell_min) / 2
             end as price
        from held h
        left join lateral (
          select m.buy_max, m.sell_min
            from public.market_price_over_time m
           where m.market = 'jita' and m.type_id = h.type_id and m.valid_from <= v_at
           order by m.valid_from desc
           limit 1
        ) p on true
       where not exists (
         select 1 from public.sde_published_type t where t.type_id = h.type_id and t.category_id = 9
       )
    )
    insert into public.asset_value_day as d (
      registration_id, corporation_id, utc_day, as_of,
      value, priced_types, unpriced_types, unpriced_units, computed_at
    )
    select p_registration_id, p_corporation_id, v_day, v_at,
           round(coalesce(sum(units * price), 0), 2),
           count(*) filter (where price is not null),
           count(*) filter (where price is null),
           coalesce(sum(units) filter (where price is null), 0),
           now()
      from priced
    on conflict (owner_key, utc_day) do update
       set as_of          = excluded.as_of,
           value          = excluded.value,
           priced_types   = excluded.priced_types,
           unpriced_types = excluded.unpriced_types,
           unpriced_units = excluded.unpriced_units,
           computed_at    = excluded.computed_at;

    v_written := v_written + 1;
  end loop;

  return v_written;
end;
$$;

revoke execute on function public.asset_value_day_compute(uuid, bigint, date, date) from public, anon, authenticated;
grant execute on function public.asset_value_day_compute(uuid, bigint, date, date) to service_role;
