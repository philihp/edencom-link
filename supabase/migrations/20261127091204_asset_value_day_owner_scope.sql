-- asset_value_day_compute counted an item for an owner after it had left them.
--
-- A past day keeps an item's version when a later version of the item exists,
-- since versions closed before 2026-10 carry the last sighting as valid_until,
-- not the close. That test asked for a later version in either hangar, of any
-- owner. So an item one owner gave to another (a character or a corporation)
-- still counted for the giver on every day from when it left until the
-- receiver's version began: the giver's last version had a later version,
-- the receiver's. An item that moved on long after the giver last held it
-- (through a contract, an untracked character, a hangar first extracted
-- later) counted for the giver over the whole gap. Past days were too high by
-- everything in such a gap, and the error ended as each receiver's version
-- began, which drew a crash on the chart that never happened.
--
-- The later version must now be the same owner's. An item that moved under an
-- old-style close leaves the giver at its last sighting there, at most one
-- extract interval early.
--
-- Open orders take the same scope.
--
-- After this applies, `pnpm run asset-values` rewrites the stored days.

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
-- a later version of the same owner (the item was still held, in some other
-- state; another owner's later version means the item left). The last
-- test covers the versions closed before 2026-10, whose valid_until was the
-- last sighting rather than the close. Today is the plain current snapshot.
--
-- The jobs at a moment: each manufacturing (activity 1) or reaction (9) job
-- of the owner, read at its latest version, installed by then, and not yet
-- delivered (a delivered job's output is in the hangar from completed_date).
-- A cancelled or reverted job counts until its completed_date. A job that
-- left ESI's listing before a terminal state was seen counts until its row
-- was closed. A job both extracts list is the corporation's, as on /industry.
-- The part done is the share of start → end elapsed, clamped to [0, 1]. The
-- bill is the SDE's per-run quantities at the blueprint's ME, with the game's
-- rounding — max(runs, ceil(round(runs × base × (1 − ME/100), 2))) — the rule
-- src/app/industry/lift.ts applies. ME is the blueprint item's, from its
-- latest version before the install, else 0; reactions have none.
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
  v_value          numeric;
  v_priced_types   integer;
  v_unpriced_types integer;
  v_unpriced_units bigint;
  v_job_value      numeric;
  v_jobs           integer;
  v_unpriced_jobs  integer;
  v_sell_value     numeric;
  v_unpriced_sell  integer;
  v_escrow         numeric;
  v_contract_value numeric;
  v_wallet         numeric;
  v_character_id   bigint;
  v_user_id        uuid;
begin
  if (p_registration_id is null) = (p_corporation_id is null) then
    raise exception 'asset_value_day_compute: name exactly one owner' using errcode = '22023';
  end if;

  select r.character_id, r.user_id into v_character_id, v_user_id
    from public.registration r where r.id = p_registration_id;

  for v_day in
    select d::date from generate_series(p_from, least(p_to, v_today), interval '1 day') d
  loop
    v_live := v_day = v_today;
    v_at := case when v_live then now() else (v_day + 1)::timestamp at time zone 'utc' end;

    continue when not exists (
      select 1 from public.market_price_over_time
       where market = 'jita' and type_id = 34 and valid_from <= v_at
    );

    -- ── The hangar ──────────────────────────────────────────────────────
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
          or exists (select 1 from public.character_asset_version n
                      where p_registration_id is not null
                        and n.item_id = h.item_id and n.registration_id = p_registration_id and n.valid_from > v_at)
          or exists (select 1 from public.corp_asset_version n
                      where p_corporation_id is not null
                        and n.item_id = h.item_id and n.corporation_id = p_corporation_id and n.valid_from > v_at)
       group by h.type_id
    ),
    priced as (
      select h.units, public.asset_value_price(h.type_id, v_at) as price
        from held h
       where not exists (
         select 1 from public.sde_published_type t where t.type_id = h.type_id and t.category_id = 9
       )
    )
    select round(coalesce(sum(units * price), 0), 2),
           count(*) filter (where price is not null),
           count(*) filter (where price is null),
           coalesce(sum(units) filter (where price is null), 0)
      into v_value, v_priced_types, v_unpriced_types, v_unpriced_units
      from priced;

    -- ── Jobs in progress ────────────────────────────────────────────────
    with latest as (
      select distinct on (j.job_id) j.*
        from (
          select job_id, activity_id, blueprint_id, blueprint_type_id, runs, status,
                 start_date, end_date, completed_date, is_current, valid_from, valid_until
            from public.character_industry_job_over_time c
           where p_registration_id is not null
             and c.registration_id = p_registration_id
             and c.activity_id in (1, 9)
             and c.start_date <= v_at
             and not exists (select 1 from public.corp_industry_job_over_time o where o.job_id = c.job_id)
          union all
          select job_id, activity_id, blueprint_id, blueprint_type_id, runs, status,
                 start_date, end_date, completed_date, is_current, valid_from, valid_until
            from public.corp_industry_job_over_time c
           where p_corporation_id is not null
             and c.corporation_id = p_corporation_id
             and c.activity_id in (1, 9)
             and c.start_date <= v_at
        ) j
       order by j.job_id, j.valid_from desc
    ),
    running as (
      select l.*,
             least(1, greatest(0,
               extract(epoch from (v_at - l.start_date))
               / nullif(extract(epoch from (l.end_date - l.start_date)), 0)
             ))::numeric as done
        from latest l
       where (l.completed_date is null or l.completed_date > v_at)
         and (l.is_current or l.status in ('delivered', 'cancelled', 'reverted') or l.valid_until > v_at)
    ),
    billed as (
      select r.job_id, coalesce(r.done, 1) as done, r.runs, b.product_type_id, b.product_quantity, b.materials,
             case when r.activity_id = 1 then coalesce((
               select me.material_efficiency
                 from (
                   select material_efficiency, valid_from from public.character_blueprint_over_time
                    where item_id = r.blueprint_id
                   union all
                   select material_efficiency, valid_from from public.corp_blueprint_over_time
                    where item_id = r.blueprint_id
                 ) me
                order by (me.valid_from <= r.start_date) desc, me.valid_from desc
                limit 1
             ), 0) else 0 end as me
        from running r
        join lateral (
          select p.product_type_id, p.product_quantity, p.materials
            from public.sde_blueprint_product p
           where p.blueprint_type_id = r.blueprint_type_id
             and p.activity_id = case when r.activity_id = 9 then 11 else 1 end
           limit 1
        ) b on true
    ),
    valued as (
      select b.job_id, b.done,
             b.runs * b.product_quantity * public.asset_value_price(b.product_type_id, v_at) as output_value,
             (select sum(greatest(b.runs, ceil(round(b.runs * (m ->> 'quantity')::numeric * (1 - b.me / 100.0), 2)))
                         * public.asset_value_price((m ->> 'typeID')::bigint, v_at))
                from jsonb_array_elements(b.materials) m) as input_value,
             (select count(*) from jsonb_array_elements(b.materials) m
               where public.asset_value_price((m ->> 'typeID')::bigint, v_at) is null) as unpriced_inputs
        from billed b
    )
    select round(coalesce(sum((1 - done) * coalesce(input_value, 0) + done * output_value)
                          filter (where output_value is not null and unpriced_inputs = 0), 0), 2),
           count(*) filter (where output_value is not null and unpriced_inputs = 0),
           count(*) filter (where output_value is null or unpriced_inputs > 0)
      into v_job_value, v_jobs, v_unpriced_jobs
      from valued;

    -- ── Market orders ───────────────────────────────────────────────────
    -- Each order at its latest version begun by then, open while current,
    -- not yet closed, or superseded later (the assets rule).
    with ov as (
      select distinct on (o.order_id) o.order_id, o.type_id, o.is_buy, o.volume_remain, o.escrow,
             o.is_current, o.valid_until
        from public.character_order_over_time o
       where p_registration_id is not null
         and o.registration_id = p_registration_id
         and o.valid_from <= v_at
         and (o.is_current or not v_live)
       order by o.order_id, o.valid_from desc
    ),
    open_orders as (
      select ov.*, case when ov.is_buy then null else public.asset_value_price(ov.type_id, v_at) end as price
        from ov
       where ov.is_current
          or ov.valid_until > v_at
          or exists (select 1 from public.character_order_over_time n
                      where n.order_id = ov.order_id and n.registration_id = p_registration_id and n.valid_from > v_at)
    )
    select round(coalesce(sum(volume_remain * price) filter (where not is_buy), 0), 2),
           count(*) filter (where not is_buy and price is null),
           round(coalesce(sum(escrow) filter (where is_buy), 0), 2)
      into v_sell_value, v_unpriced_sell, v_escrow
      from open_orders;

    -- ── Contracts in flight ─────────────────────────────────────────────
    with k as (
      select c.contract_id, c.type, c.collateral, c.issuer_id, c.issuer_corporation_id, c.acceptor_id,
             c.for_corporation,
             (not c.for_corporation and c.issuer_id = v_character_id) as ours_issued,
             (c.acceptor_id = v_character_id) as ours_accepted,
             (select s.status from public.character_contract_status_over_time s
               where s.registration_id = c.registration_id and s.contract_id = c.contract_id and s.valid_from <= v_at
               order by s.valid_from desc limit 1) as status,
             (select sum(i.quantity * public.asset_value_price(i.type_id, v_at))
                from public.character_contract_item i
               where i.registration_id = c.registration_id and i.contract_id = c.contract_id and i.is_included
                 and not exists (select 1 from public.sde_published_type t where t.type_id = i.type_id and t.category_id = 9)
             ) as items_value
        from public.character_contract c
       where p_registration_id is not null
         and c.registration_id = p_registration_id
         and c.date_issued <= v_at
      union all
      select c.contract_id, c.type, c.collateral, c.issuer_id, c.issuer_corporation_id, c.acceptor_id,
             c.for_corporation,
             (c.for_corporation and c.issuer_corporation_id = p_corporation_id) as ours_issued,
             (c.acceptor_id = p_corporation_id) as ours_accepted,
             (select s.status from public.corp_contract_status_over_time s
               where s.corporation_id = c.corporation_id and s.contract_id = c.contract_id and s.valid_from <= v_at
               order by s.valid_from desc limit 1) as status,
             (select sum(i.quantity * public.asset_value_price(i.type_id, v_at))
                from public.corp_contract_item i
               where i.corporation_id = c.corporation_id and i.contract_id = c.contract_id and i.is_included
                 and not exists (select 1 from public.sde_published_type t where t.type_id = i.type_id and t.category_id = 9)
             ) as items_value
        from public.corp_contract c
       where p_corporation_id is not null
         and c.corporation_id = p_corporation_id
         and c.date_issued <= v_at
    ),
    internal as (
      -- An issuer inside the owner's own account (or, for a corporation, one
      -- of its registered members or the corporation itself): that side
      -- already counts the courier's stake.
      select k.contract_id,
             (p_registration_id is not null and (
                (not k.for_corporation and k.issuer_id in (select r.character_id from public.registration r where r.user_id = v_user_id))
                or (k.for_corporation and k.issuer_corporation_id in (
                      select r.corporation_id from public.registration r where r.user_id = v_user_id and r.corporation_id is not null))))
             or (p_corporation_id is not null and (
                (k.for_corporation and k.issuer_corporation_id = p_corporation_id)
                or (not k.for_corporation and k.issuer_id in (
                      select r.character_id from public.registration r where r.corporation_id = p_corporation_id))))
               as is_internal
        from k
       where k.ours_accepted
    )
    select round(coalesce(sum(
             case
               when k.ours_issued and k.type in ('item_exchange', 'auction') and k.status = 'outstanding'
                 then coalesce(k.items_value, 0)
               when k.ours_issued and k.type = 'courier' and k.status in ('outstanding', 'in_progress')
                 then coalesce(k.collateral, 0)
               when k.ours_accepted and not k.ours_issued and k.type = 'courier' and k.status = 'in_progress'
                    and not coalesce((select i.is_internal from internal i where i.contract_id = k.contract_id), false)
                 then coalesce(k.collateral, 0)
               else 0
             end), 0), 2)
      into v_contract_value
      from k;

    -- ── Wallet ──────────────────────────────────────────────────────────
    if p_registration_id is not null then
      select w.balance into v_wallet
        from public.character_wallet w
       where w.registration_id = p_registration_id and w.recorded_at <= v_at
       order by w.recorded_at desc
       limit 1;
    else
      select sum(w.balance) into v_wallet
        from (
          select distinct on (division) balance
            from public.corp_wallet
           where corporation_id = p_corporation_id and recorded_at <= v_at
           order by division, recorded_at desc
        ) w;
    end if;

    insert into public.asset_value_day (
      registration_id, corporation_id, utc_day, as_of,
      value, priced_types, unpriced_types, unpriced_units,
      job_value, jobs, unpriced_jobs,
      sell_order_value, buy_escrow, contract_value, wallet, computed_at
    ) values (
      p_registration_id, p_corporation_id, v_day, v_at,
      v_value, v_priced_types, v_unpriced_types + v_unpriced_sell, v_unpriced_units,
      v_job_value, v_jobs, v_unpriced_jobs,
      v_sell_value, v_escrow, v_contract_value, coalesce(v_wallet, 0), now()
    )
    on conflict (owner_key, utc_day) do update
       set as_of          = excluded.as_of,
           value          = excluded.value,
           priced_types   = excluded.priced_types,
           unpriced_types = excluded.unpriced_types,
           unpriced_units = excluded.unpriced_units,
           job_value      = excluded.job_value,
           jobs           = excluded.jobs,
           unpriced_jobs  = excluded.unpriced_jobs,
           sell_order_value = excluded.sell_order_value,
           buy_escrow     = excluded.buy_escrow,
           contract_value = excluded.contract_value,
           wallet         = excluded.wallet,
           computed_at    = excluded.computed_at;

    v_written := v_written + 1;
  end loop;

  return v_written;
end;
$$;

revoke execute on function public.asset_value_day_compute(uuid, bigint, date, date) from public, anon, authenticated;
grant execute on function public.asset_value_day_compute(uuid, bigint, date, date) to service_role;
