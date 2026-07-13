-- Mercenary den security-model + data-model redesign.
--
-- 1. Split the volatile observed state out of character_mercenary_den into an
--    append-only character_mercenary_den_status history table (development, anarchy,
--    infomorphs, running state, reinforcement timer).
-- 2. Turn character_mercenary_den into an SCD-2 table (character_mercenary_den_
--    over_time) + a current-snapshot view, like character_asset_over_time.
-- 3. Corp sharing via an explicit RLS-free character_mercenary_den_share join table; the
--    user_settings.share_mercenary_dens flag is scrapped (that table holds the
--    secret api_token and must not be exposed cross-user).

-- ── 1. Append-only status history (backfilled from the current den snapshot) ─
create table if not exists public.character_mercenary_den_status (
  id bigint generated always as identity primary key,
  character_id uuid not null references public.registration(id) on delete cascade,
  den_id bigint not null,
  state text,
  development_level text,
  development_amount bigint,
  anarchy_level text,
  anarchy_amount bigint,
  infomorphs bigint,
  reinforcement_end timestamptz,
  observed_at timestamptz not null default now()
);
create index if not exists character_mercenary_den_status_den_idx
  on public.character_mercenary_den_status (character_id, den_id, observed_at desc);
alter table public.character_mercenary_den_status enable row level security;

-- Seed one observation per existing den from its current columns before those
-- columns are dropped, so the latest known state isn't lost.
insert into public.character_mercenary_den_status
  (character_id, den_id, state, development_level, development_amount,
   anarchy_level, anarchy_amount, infomorphs, reinforcement_end, observed_at)
select character_id, den_id, state, development_level, development_amount,
       anarchy_level, anarchy_amount, infomorphs, reinforcement_end, recorded_at
from public.character_mercenary_den;

-- ── 2. Convert character_mercenary_den into an SCD-2 table + current view ───
-- Drop the old own-rows policy (recreated on the renamed table below).
drop policy if exists "Users read own mercenary dens" on public.character_mercenary_den;

alter table public.character_mercenary_den rename to character_mercenary_den_over_time;

-- Swap the composite PK for a surrogate id and add SCD-2 bookkeeping; the
-- existing rows become the current (is_current = true) versions.
alter table public.character_mercenary_den_over_time drop constraint character_mercenary_den_pkey;
alter table public.character_mercenary_den_over_time
  add column id bigint generated always as identity primary key,
  add column is_current boolean not null default true,
  add column valid_from timestamptz not null default now(),
  add column valid_until timestamptz not null default now();
update public.character_mercenary_den_over_time
  set valid_from = recorded_at, valid_until = recorded_at;

-- Drop the volatile columns (now in character_mercenary_den_status), recorded_at (replaced
-- by valid_from/valid_until), and the never-shipped denormalized columns from an
-- earlier iteration of this PR (if exists → no-op in prod).
alter table public.character_mercenary_den_over_time
  drop column if exists state,
  drop column if exists development_level,
  drop column if exists development_amount,
  drop column if exists anarchy_level,
  drop column if exists anarchy_amount,
  drop column if exists infomorphs,
  drop column if exists reinforcement_end,
  drop column if exists recorded_at,
  drop column if exists corporation_id,
  drop column if exists shared;

alter index if exists character_mercenary_den_character_id_idx
  rename to character_mercenary_den_over_time_character_id_idx;
create unique index if not exists character_mercenary_den_over_time_current_idx
  on public.character_mercenary_den_over_time (character_id, den_id) where is_current;
create index if not exists character_mercenary_den_over_time_den_idx
  on public.character_mercenary_den_over_time (character_id, den_id, valid_until desc);

create policy "Users read own mercenary dens"
  on public.character_mercenary_den_over_time
  for select
  to authenticated
  using (
    character_id in (select id from public.registration where user_id = (select auth.uid()))
  );

create view public.character_mercenary_den with (security_invoker = on) as
  select
    d.*,
    s.state,
    s.development_level,
    s.development_amount,
    s.anarchy_level,
    s.anarchy_amount,
    s.infomorphs,
    s.reinforcement_end,
    s.observed_at as status_observed_at
  from public.character_mercenary_den_over_time d
  left join lateral (
    select state, development_level, development_amount, anarchy_level, anarchy_amount,
           infomorphs, reinforcement_end, observed_at
    from public.character_mercenary_den_status s
    where s.character_id = d.character_id and s.den_id = d.den_id
    order by s.observed_at desc
    limit 1
  ) s on true
  where d.is_current;

grant select on public.character_mercenary_den_over_time to authenticated;
grant select on public.character_mercenary_den           to authenticated;
grant all    on public.character_mercenary_den_over_time to service_role;

-- Status visibility mirrors den visibility (any version of the den).
drop policy if exists "Read status for visible mercenary dens" on public.character_mercenary_den_status;
create policy "Read status for visible mercenary dens"
  on public.character_mercenary_den_status
  for select
  to authenticated
  using (
    exists (
      select 1 from public.character_mercenary_den_over_time d
      where d.character_id = character_mercenary_den_status.character_id
        and d.den_id = character_mercenary_den_status.den_id
    )
  );

grant select on public.character_mercenary_den_status to authenticated;
grant all    on public.character_mercenary_den_status to service_role;

-- ── Scrap the user_settings share flag ─────────────────────────────────────
-- Sharing moved to character_mercenary_den_share; user_settings holds the api_token and
-- must not gain any cross-user-read surface. Drops both the shipped plural name
-- and the singular one an in-flight iteration briefly used.
alter table public.user_settings
  drop column if exists share_mercenary_dens,
  drop column if exists share_mercenary_den;

-- ── 3. Corp sharing via an explicit join table ─────────────────────────────
-- Drop the earlier (unshipped) iterations' policy/view if present.
drop policy if exists "Corpmates read shared mercenary dens" on public.character_mercenary_den_over_time;
drop view if exists public.shared_mercenary_den_characters;

-- Many-to-many: one row shares one den to one corporation. NO row-level security
-- (see schema.sql) — it holds only the non-sensitive "den D shared to corp C",
-- and the policy below reads it cross-user. Writes are service-role only.
create table if not exists public.character_mercenary_den_share (
  character_id uuid not null references public.registration(id) on delete cascade,
  den_id bigint not null,
  corporation_id bigint not null,
  created_at timestamptz not null default now(),
  primary key (character_id, den_id, corporation_id)
);
create index if not exists character_mercenary_den_share_corporation_id_idx
  on public.character_mercenary_den_share (corporation_id);

grant select on public.character_mercenary_den_share to authenticated;
grant all    on public.character_mercenary_den_share to service_role;

-- A den is visible to the caller when it has been shared to a corporation the
-- caller owns a character in. Additive/permissive: OR'd with "Users read own
-- mercenary dens".
create policy "Corpmates read shared mercenary dens"
  on public.character_mercenary_den_over_time
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.character_mercenary_den_share sh
      where sh.character_id = character_mercenary_den_over_time.character_id
        and sh.den_id = character_mercenary_den_over_time.den_id
        and sh.corporation_id in (
          select c.corporation_id from public.registration c
          where c.user_id = (select auth.uid()) and c.corporation_id is not null
        )
    )
  );
