-- Character and corporation blueprints, mirroring the character_asset_over_time
-- / corp_asset_over_time SCD Type 2 pattern, replacing GESI's
-- characters_character_blueprints / corporations_corporation_blueprints sheet
-- functions. quantity is -1 for an original (BPO), -2 for a copy (BPC), or the
-- stack size for multiple BPOs stacked together; runs is -1 for a BPO
-- (unlimited) or the runs remaining on a BPC. ESI's blueprint payload has no
-- location_type (unlike assets), so that column isn't tracked here.

-- ── character_blueprint_over_time ─────────────────────────────────────────
create table public.character_blueprint_over_time (
  id bigint generated always as identity primary key,
  item_id bigint not null,
  character_id uuid not null references public.registration(id) on delete cascade,
  type_id bigint not null,
  location_id bigint,
  location_flag text,
  quantity bigint,
  material_efficiency smallint,
  time_efficiency smallint,
  runs integer,
  is_current boolean not null default true,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index character_blueprint_over_time_character_id_idx on public.character_blueprint_over_time (character_id);
create unique index character_blueprint_over_time_current_item_idx on public.character_blueprint_over_time (item_id) where is_current;
create index character_blueprint_over_time_item_id_idx on public.character_blueprint_over_time (item_id, last_seen_at desc);

alter table public.character_blueprint_over_time enable row level security;
create policy "Users read own blueprints"
  on public.character_blueprint_over_time
  for select
  to authenticated
  using (
    character_id in (
      select id from public.registration where user_id = (select auth.uid())
    )
  );

create view public.character_blueprint with (security_invoker = on) as
  select * from public.character_blueprint_over_time where is_current;

grant select on public.character_blueprint_over_time to authenticated;
grant select on public.character_blueprint           to authenticated;
grant all    on public.character_blueprint_over_time to service_role;

create or replace function public.character_blueprints(character_ids uuid[])
returns json
language sql
stable
as $$
  select coalesce(
    json_agg(
      json_build_object(
        'item_id',             b.item_id,
        'location_flag',       b.location_flag,
        'location_id',         b.location_id,
        'material_efficiency', b.material_efficiency,
        'quantity',            b.quantity,
        'runs',                b.runs,
        'time_efficiency',     b.time_efficiency,
        'type_id',             b.type_id,
        'character_name',      r.name
      )
      order by b.item_id
    ),
    '[]'::json
  )
  from public.character_blueprint b
  join public.registration r on r.id = b.character_id
  where b.character_id = any(character_ids);
$$;

grant execute on function public.character_blueprints(uuid[]) to service_role;

-- ── corp_blueprint_over_time ──────────────────────────────────────────────
create table public.corp_blueprint_over_time (
  id bigint generated always as identity primary key,
  item_id bigint not null,
  corporation_id bigint not null,
  type_id bigint not null,
  location_id bigint,
  location_flag text,
  quantity bigint,
  material_efficiency smallint,
  time_efficiency smallint,
  runs integer,
  is_current boolean not null default true,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index corp_blueprint_over_time_corporation_id_idx on public.corp_blueprint_over_time (corporation_id);
create unique index corp_blueprint_over_time_current_item_idx on public.corp_blueprint_over_time (item_id) where is_current;
create index corp_blueprint_over_time_item_id_idx on public.corp_blueprint_over_time (item_id, last_seen_at desc);

alter table public.corp_blueprint_over_time enable row level security;
create policy "Users read blueprints for own corps"
  on public.corp_blueprint_over_time
  for select
  to authenticated
  using (
    corporation_id in (
      select corporation_id from public.registration
      where user_id = (select auth.uid()) and corporation_id is not null
    )
  );

create view public.corp_blueprint with (security_invoker = on) as
  select * from public.corp_blueprint_over_time where is_current;

grant select on public.corp_blueprint_over_time to authenticated;
grant select on public.corp_blueprint           to authenticated;
grant all    on public.corp_blueprint_over_time to service_role;

create or replace function public.corp_blueprints(character_ids uuid[])
returns json
language sql
stable
as $$
  select coalesce(
    json_agg(
      json_build_object(
        'item_id',             b.item_id,
        'corporation_id',      b.corporation_id,
        'location_flag',       b.location_flag,
        'location_id',         b.location_id,
        'material_efficiency', b.material_efficiency,
        'quantity',            b.quantity,
        'runs',                b.runs,
        'time_efficiency',     b.time_efficiency,
        'type_id',             b.type_id
      )
      order by b.item_id
    ),
    '[]'::json
  )
  from public.corp_blueprint b
  where b.corporation_id in (
    select corporation_id from public.registration
    where id = any(character_ids) and corporation_id is not null
  );
$$;

grant execute on function public.corp_blueprints(uuid[]) to service_role;
