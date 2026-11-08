-- planner_stock_target — the industry planner's make-to-stock directive
-- (/industry/planner/stock-types): one row per item type the account wants to
-- keep in stock, with how many to hold in general supply (backup), in the home
-- market and in Jita. Modelled on the StockTypes tab of the T2 sheet the
-- planner ports (industry-planner/plan.md in the project files).
--
-- Keyed on user_id, like link and watched_system: the plan is the account's,
-- pooled across its characters, since the stock it directs is built and sold
-- by whichever character is at hand. Type ids come from the SDE mirror; the
-- server action checks the id names a published type before it writes.
create table public.planner_stock_target (
  user_id    uuid    not null references auth.users(id) on delete cascade,
  type_id    bigint  not null,
  backup     integer not null default 0 check (backup >= 0),
  home       integer not null default 0 check (home >= 0),
  jita       integer not null default 0 check (jita >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, type_id)
);
create index planner_stock_target_user_id_idx on public.planner_stock_target (user_id);

alter table public.planner_stock_target enable row level security;
create policy "Users manage own stock targets"
  on public.planner_stock_target
  for all
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

grant select, insert, update, delete on public.planner_stock_target to authenticated;
grant all                            on public.planner_stock_target to service_role;
