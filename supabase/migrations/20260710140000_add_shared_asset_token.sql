-- Public share links for a user's own assets: /ship/[itemId]?token=… (and
-- /asset/[locationId]?token=… for hangars). Anonymous viewers never query
-- this table directly — the server resolves the token with the service-role
-- client and scopes every asset query to the sharing user's characters/corps,
-- so there is deliberately no anon/public policy.
create table public.shared_asset_token (
  token text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  item_id bigint not null,
  created_at timestamptz not null default now(),
  unique (user_id, item_id)
);
create index shared_asset_token_user_id_idx on public.shared_asset_token (user_id);

alter table public.shared_asset_token enable row level security;
create policy "Users manage own share tokens"
  on public.shared_asset_token
  for all
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

grant select, insert, update, delete on public.shared_asset_token to authenticated;
grant all    on public.shared_asset_token to service_role;
