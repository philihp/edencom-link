-- Universal id->name directories for alliances and corporations, not siloed
-- by user -- the same shape as industry_system_index: whoever's data we're
-- extracting, we all share one copy. Populated whenever an alliance/corp is
-- seen anywhere, not just for ones a user has registered.
create table public.alliance (
  alliance_id bigint primary key,
  name text not null,
  updated_at timestamptz not null default now()
);

alter table public.alliance enable row level security;
create policy "Everyone reads alliances"
  on public.alliance
  for select
  to anon, authenticated
  using (true);

grant select on public.alliance to anon, authenticated;
grant all    on public.alliance to service_role;

create table public.corporation (
  corporation_id bigint primary key,
  name text not null,
  alliance_id bigint references public.alliance (alliance_id),
  updated_at timestamptz not null default now()
);
create index corporation_alliance_id_idx on public.corporation (alliance_id);

alter table public.corporation enable row level security;
create policy "Everyone reads corporations"
  on public.corporation
  for select
  to anon, authenticated
  using (true);

grant select on public.corporation to anon, authenticated;
grant all    on public.corporation to service_role;
