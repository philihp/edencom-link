-- A character's currently open market orders (ESI /characters/{id}/orders/),
-- populated by the orders job. It keeps this a live snapshot: each run upserts
-- every open order and sweeps away that character's rows it didn't see (filled,
-- expired or cancelled). is_buy is false for sell orders (ESI omits is_buy_order
-- on those); escrow/min_volume are buy-order-only, hence nullable.
create table if not exists public.market_order (
  order_id bigint primary key,
  character_id uuid not null references public.registration(id) on delete cascade,
  type_id bigint not null,
  region_id bigint not null,
  location_id bigint not null,
  range text not null,
  is_buy boolean not null,
  is_corporation boolean not null,
  price numeric(20, 2) not null,
  volume_total bigint not null,
  volume_remain bigint not null,
  min_volume bigint,
  escrow numeric(20, 2),
  duration integer not null,
  issued timestamptz not null,
  seen_at timestamptz not null default now()
);
create index if not exists market_order_character_id_issued_idx on public.market_order (character_id, issued desc);

alter table public.market_order enable row level security;
create policy "Users read own orders"
  on public.market_order
  for select
  to authenticated
  using (
    character_id in (
      select id from public.registration where user_id = (select auth.uid())
    )
  );

grant select on public.market_order to authenticated;
grant all    on public.market_order to service_role;
