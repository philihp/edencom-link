-- CCP's adjusted prices, from public ESI GET /markets/prices/ — the price base
-- the game itself uses to compute an industry job's Estimated Item Value, and
-- so the missing multiplier in every job-cost breakdown (docs/cost-avoidance.md
-- derived cost avoidance from tax receipts precisely because nothing ingested
-- this feed). One row per type, upserted daily by the market-adjusted-prices
-- job: adjusted_price is a slow-moving smoothed average, so latest-only is a
-- deliberate approximation — recovering a tax rate divides a job's cost by its
-- EIV, and days of drift move that figure by less than the rounding on a
-- 0.25–1% rate. recorded_at says how stale the approximation is.
--
-- World-readable like industry_system_index: game-wide public data with no
-- player in it.
create table public.market_adjusted_price (
  type_id bigint primary key,
  adjusted_price double precision not null,
  -- ESI omits average_price for ~13% of types; null means "not published",
  -- which is different from zero.
  average_price double precision,
  recorded_at timestamptz not null default now()
);

alter table public.market_adjusted_price enable row level security;
create policy "Everyone reads adjusted prices"
  on public.market_adjusted_price
  for select
  to anon, authenticated
  using (true);

grant select on public.market_adjusted_price to anon, authenticated;
grant all    on public.market_adjusted_price to service_role;
