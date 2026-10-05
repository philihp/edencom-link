-- market_price_at() timed out on /industry's first day in production — the
-- authenticated role's 8s statement_timeout cancelled its sequential pass over
-- market_price_over_time (seven weeks of hourly captures by then), so every
-- job read as unpriced. docs/market-prices/README.md "Storage" named the
-- (market, type_id, valid_from) btree as the lever if /industry outgrew the
-- scan; it did, so this pulls it. With the index each probe is one index
-- lookup — the latest version at or before its moment, else the earliest
-- after it — instead of a share of a whole-table scan and sort.
--
-- A plain (not CONCURRENTLY) build: migrations run inside a transaction, where
-- CONCURRENTLY is not allowed. The build holds a SHARE lock, which lets every
-- reader through and blocks only the hourly market-prices write for the
-- build's duration; the service role's lock_timeout is 30s, so a run that
-- collides fails its hour and the next one carries on.
create index if not exists market_price_over_time_type_history_idx
  on public.market_price_over_time (market, type_id, valid_from);

-- Same contract as before (one answer per probe that has any version at all,
-- `exact` false when the moment predates the capture, json rather than setof
-- so max_rows never truncates). The shape changes from one join-and-sort over
-- every version of the probed types to a lateral lookup per probe: the index
-- answers "latest valid_from at or before" with one descending probe, and the
-- LIMIT over the UNION ALL stops after the first branch answers, so the
-- fallback branch is read only when nothing came before the moment.
create or replace function public.market_price_at(market_id text, probes jsonb)
returns json
language sql
stable
as $$
  select coalesce(
    json_agg(
      json_build_object(
        'type_id',  q.type_id,
        'as_of',    q.as_of,
        'buy_max',  p.buy_max,
        'sell_min', p.sell_min,
        'since',    p.valid_from,
        'exact',    (p.valid_from <= q.as_of)
      )
      order by q.type_id, q.as_of
    ),
    '[]'::json
  )
  from (
    select distinct type_id, as_of
    from jsonb_to_recordset(probes) as x(type_id bigint, as_of timestamptz)
  ) q
  cross join lateral (
    (
      select v.buy_max, v.sell_min, v.valid_from
      from public.market_price_over_time v
      where v.market = market_id and v.type_id = q.type_id and v.valid_from <= q.as_of
      order by v.valid_from desc
      limit 1
    )
    union all
    (
      select v.buy_max, v.sell_min, v.valid_from
      from public.market_price_over_time v
      where v.market = market_id and v.type_id = q.type_id and v.valid_from > q.as_of
      order by v.valid_from asc
      limit 1
    )
    limit 1
  ) p;
$$;

grant execute on function public.market_price_at(text, jsonb) to anon, authenticated, service_role;
