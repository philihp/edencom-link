-- A Chancellor-set price for each hull no market prices (supercarriers and
-- titans), used by the ship card and the Appraise button; and a per-ship cache
-- of the last appraisal, so the card does not ask the provider on every render.
-- See the table comments in schema.sql.

-- Prices for hulls no market prices: supercarriers and titans cannot enter
-- high-sec, so they change hands by contract, mostly inside an alliance, and
-- no order book (appraise.gnf.lt, innomin.at) holds a price for them. Without
-- this table an appraisal of one leaves the hull out and reports a small
-- fraction of its worth.
--
-- One row per hull type: the ISK a Chancellor sets on
-- /account/settings/chancellor/hull-prices. A row wins over any market price
-- for its type, in the ship card and in the Appraise button (src/hullPrices.ts).
-- No row means "no set price", and the market price (if any) stands.
--
-- Readable by everyone, like market_price: an estimate of what a hull costs is
-- not player data. updated_by is left out of that grant, so the table does not
-- say which account set a price. Writes go through the service role only,
-- after the Chancellor check in the page's server action.
create table public.hull_price (
  type_id bigint primary key,
  price numeric not null check (price >= 0),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);

alter table public.hull_price enable row level security;
create policy "Everyone reads hull prices"
  on public.hull_price
  for select
  to anon, authenticated
  using (true);

revoke all on public.hull_price from anon, authenticated;
grant select (type_id, price, updated_at) on public.hull_price to anon, authenticated;
grant all on public.hull_price to service_role;

-- ── ship_appraisal ────────────────────────────────────────────────────────
-- The last innomin.at appraisal of one ship: per line, the unit prices the
-- provider answered with. The Appraise button on the ship page writes it, and
-- the ship's link-preview card reads it, so posting and re-posting a share link
-- does not send a new request to the provider each time (its budget is 200 an
-- hour, for the whole deployment). The card asks again only when the row is
-- older than its time limit (src/app/ship/[itemId]/card/loadCard.ts).
--
-- Unit prices, not totals: hull_price is applied when the row is read, so a
-- Chancellor's price change shows at once, without a new appraisal.
--
-- Keyed by item id, so it says what a player's ship holds and is worth: no
-- policy, service role only, like esi_etag. Both writers have already proved
-- the caller may see the ship (an RLS walk, or a verified share link).
create table public.ship_appraisal (
  item_id bigint primary key,
  market text not null,
  -- [{ name, quantity, sell, buy }]; sell and buy are null for a line the
  -- provider could not price.
  lines jsonb not null,
  appraised_at timestamptz not null default now()
);

alter table public.ship_appraisal enable row level security;
revoke all on public.ship_appraisal from anon, authenticated;
grant all on public.ship_appraisal to service_role;

-- Starting prices. They float, and a Chancellor keeps them current from the
-- settings page; faction hulls start with no row, so they stay unpriced until
-- someone sets one.
insert into public.hull_price (type_id, price) values
  (23913, 42000000000), -- Nyx
  (22852, 42000000000), -- Hel
  (23917, 42000000000), -- Wyvern
  (23919, 42000000000), -- Aeon
  (671, 128000000000), -- Erebus
  (3764, 128000000000), -- Leviathan
  (11567, 128000000000), -- Avatar
  (23773, 128000000000) -- Ragnarok
on conflict (type_id) do nothing;
