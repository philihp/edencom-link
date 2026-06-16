-- Corp market transactions: the market buys/sells pulled from corporation wallet
-- divisions (esi-wallet.read_corporation_wallets.v1), unioned into the market page
-- alongside the per-character market_transaction rows. `character_id` records the
-- registration whose token scanned the row; RLS scopes reads to that character's
-- owner, so a corp transaction is only visible to the player who pulled it (like
-- personal transactions). Keyed by the globally-unique transaction_id so it dedupes
-- across divisions and re-scans (first scanner wins attribution).
create table if not exists public.corp_market_transaction (
  transaction_id bigint primary key,
  character_id uuid not null references public.registration(id) on delete cascade,
  corporation_id bigint not null,
  division smallint not null,
  date timestamptz not null,
  type_id bigint not null,
  quantity bigint not null,
  unit_price numeric(20, 2) not null,
  is_buy boolean not null,
  client_id bigint not null,
  location_id bigint not null,
  journal_ref_id bigint not null,
  seen_at timestamptz not null default now()
);
create index if not exists corp_market_transaction_character_id_date_idx
  on public.corp_market_transaction (character_id, date desc);

alter table public.corp_market_transaction enable row level security;

drop policy if exists "Users read own corp transactions" on public.corp_market_transaction;
create policy "Users read own corp transactions"
  on public.corp_market_transaction
  for select
  to authenticated
  using (
    character_id in (
      select id from public.registration where user_id = (select auth.uid())
    )
  );

grant select on public.corp_market_transaction to authenticated;
grant all    on public.corp_market_transaction to service_role;
