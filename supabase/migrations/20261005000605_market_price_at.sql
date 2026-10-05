-- market_price_at: one market's price for many (type, moment) pairs at once —
-- what /industry needs to price each job's material bill and product at the
-- moment the job was installed ("lift", docs/design-system/Industry.dc.html).
--
-- market_price_snapshot() answers "every type at one moment"; this answers
-- "these types at these moments", because a hangar's job history installs at
-- hundreds of distinct instants and one snapshot per instant would be hundreds
-- of 2 MB answers.
--
-- Each probe resolves to the version in effect at its moment: the row with the
-- latest valid_from at or before it (versions are contiguous, so that is the
-- one that was live). A moment before the capture began — the market-prices
-- job started 2026-08 and a job can be older — falls back to the EARLIEST
-- version instead, reported with exact = false so the caller can say so
-- rather than present a guess as a reading.
--
-- Deliberately no new index. The join needs every version of the probed types,
-- which only a btree on (market, type_id, valid_from) would serve, and
-- docs/market-prices/README.md "Storage" measured that shape out of the table
-- on purpose (a surrogate-free, BRIN-only layout is 43% smaller). So this is a
-- hash join against one sequential pass over the market's rows — the same
-- cost the time-travel branch of market_price_snapshot() already pays per
-- sheet refresh, paid once per page view here, with every probe answered from
-- that single pass. If /industry ever outgrows it, the index is the lever.
--
-- Returns json rather than setof so PostgREST's max_rows cap (1000) never
-- truncates an answer — the same reason the snapshot functions do.
-- SECURITY INVOKER, like every other function here; safe because the table is
-- world-readable by design.
create or replace function public.market_price_at(market_id text, probes jsonb)
returns json
language sql
stable
as $$
  select coalesce(
    json_agg(
      json_build_object(
        'type_id',  r.type_id,
        'as_of',    r.as_of,
        'buy_max',  r.buy_max,
        'sell_min', r.sell_min,
        'since',    r.valid_from,
        'exact',    r.exact
      )
      order by r.type_id, r.as_of
    ),
    '[]'::json
  )
  from (
    select distinct on (q.type_id, q.as_of)
      q.type_id,
      q.as_of,
      p.buy_max,
      p.sell_min,
      p.valid_from,
      (p.valid_from <= q.as_of) as exact
    from jsonb_to_recordset(probes) as q(type_id bigint, as_of timestamptz)
    join public.market_price_over_time p
      on p.market = market_id
     and p.type_id = q.type_id
    -- Versions at or before the moment first, nearest first; a moment the
    -- capture never saw takes the nearest version after it instead.
    order by
      q.type_id,
      q.as_of,
      (p.valid_from <= q.as_of) desc,
      abs(extract(epoch from (p.valid_from - q.as_of)))
  ) r;
$$;

grant execute on function public.market_price_at(text, jsonb) to anon, authenticated, service_role;
