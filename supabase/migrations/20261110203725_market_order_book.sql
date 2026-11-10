-- market_order_book: Jita sell orders for reaction gas, for gas_purchase_plan.
-- See schema.sql for the full comment.
-- ── market_order_book ─────────────────────────────────────────────────────
-- The sell orders for reaction gas at Jita 4-4, from public ESI
-- /markets/{region_id}/orders/, written hourly by the market-depth job. The
-- gas_purchase_plan MCP tool reads it to split one large purchase between
-- raw and compressed gas: a large buy walks up the book, so the best price
-- alone does not tell which form is cheaper for the whole quantity
-- (src/app/api/mcp/gasDepth.ts).
--
-- A snapshot, not a history: each run upserts the orders it saw and deletes
-- the rows of that type that the run did not see (captured_at older than the
-- run). Public game data with no player data in it, so world-readable like
-- market_price_over_time. Writes stay service-role.
create table if not exists public.market_order_book (
  order_id bigint not null,
  location_id bigint not null,
  volume_remain bigint not null,
  issued timestamptz,
  captured_at timestamptz not null,
  type_id integer not null,
  price numeric not null,
  -- The market preset this snapshot is for ('jita'), the same ids
  -- market_price_over_time uses.
  market text not null,
  primary key (market, order_id)
);

-- What the tool asks: one market's book for a few types, cheapest first.
create index if not exists market_order_book_type_idx on public.market_order_book (market, type_id, price);

alter table public.market_order_book enable row level security;
create policy "Everyone reads the order book" on public.market_order_book
  for select to anon, authenticated using (true);
grant select on public.market_order_book to anon, authenticated;
grant all    on public.market_order_book to service_role;

