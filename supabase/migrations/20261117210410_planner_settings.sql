-- The industry planner's settings tab: the plan's numbers, the manual build or
-- buy list and the manual stock list. New tables only; nothing existing changes.

-- ── planner_settings ──────────────────────────────────────────────────────
-- The industry planner's settings (/industry/planner/settings): the numbers
-- the plan computes with. One row per account; a missing row means every
-- default, so the page reads it with maybeSingle and the app holds the same
-- defaults (src/app/industry/planner/settings/settings.ts). Rates are
-- fractions (0.5 = 50%); haul costs are ISK per packaged m3. home_market names
-- a market of the hourly price capture (TRACKED_MARKETS in src/gnfMarket.js).
-- Facility tax is not here: the planner reads the two rates /settings/tax
-- already stores on user_settings.
create table public.planner_settings (
  user_id        uuid          primary key references auth.users(id) on delete cascade,
  overbuild      numeric(8, 5) not null default 0.5  check (overbuild between 0 and 10),
  minimum_margin numeric(8, 5) not null default 0.05 check (minimum_margin between -1 and 10),
  market_fees    numeric(8, 5) not null default 0.05 check (market_fees between 0 and 1),
  scc_tax        numeric(8, 5) not null default 0.04 check (scc_tax between 0 and 1),
  home_market    text          not null default 'C-J6MT',
  haul_import    numeric(12, 2) not null default 900 check (haul_import >= 0),
  haul_export    numeric(12, 2) not null default 900 check (haul_export >= 0),
  updated_at     timestamptz   not null default now()
);

alter table public.planner_settings enable row level security;
create policy "Users manage own planner settings"
  on public.planner_settings
  for all
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

grant select, insert, update, delete on public.planner_settings to authenticated;
grant all                            on public.planner_settings to service_role;

-- ── planner_build_buy ─────────────────────────────────────────────────────
-- The sheet's ManualBuildBuy: an item type the plan always builds or always
-- buys, whatever the prices say. One row per type per account.
create table public.planner_build_buy (
  user_id    uuid   not null references auth.users(id) on delete cascade,
  type_id    bigint not null,
  choice     text   not null check (choice in ('build', 'buy')),
  created_at timestamptz not null default now(),
  primary key (user_id, type_id)
);

alter table public.planner_build_buy enable row level security;
create policy "Users manage own build or buy choices"
  on public.planner_build_buy
  for all
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

grant select, insert, update, delete on public.planner_build_buy to authenticated;
grant all                            on public.planner_build_buy to service_role;

-- ── planner_manual_stock ──────────────────────────────────────────────────
-- The sheet's ManualStock: items the account holds that no extract can see
-- (another account's hangar, a friend's can), counted as on hand on top of
-- what the extracts find. One row per type per account.
create table public.planner_manual_stock (
  user_id    uuid   not null references auth.users(id) on delete cascade,
  type_id    bigint not null,
  quantity   bigint not null default 0 check (quantity >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, type_id)
);

alter table public.planner_manual_stock enable row level security;
create policy "Users manage own manual stock"
  on public.planner_manual_stock
  for all
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

grant select, insert, update, delete on public.planner_manual_stock to authenticated;
grant all                            on public.planner_manual_stock to service_role;
