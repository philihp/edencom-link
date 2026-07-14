-- Market orders and industry jobs (character + corp) were plain live-snapshot
-- tables. Convert each to the slowly-changing-dimension (SCD type 2) shape the
-- assets/blueprints/ship tables use: a *_over_time history table plus a view of
-- the same name exposing the is_current rows, so every existing reader keeps
-- working unchanged. A surrogate `id` identity becomes the primary key; the
-- business key (order_id / job_id) is now versioned, unique only among the open
-- rows. seen_at is folded into first_seen_at/last_seen_at.
--
-- The extract jobs are rewritten to reconcile: unchanged rows get last_seen_at
-- bumped, changed rows (a fill or re-price on an order; a status transition on a
-- job) close the old version and open a new one. Orders that vanish from the
-- snapshot (filled/expired/cancelled) are closed, matching the old sweep-delete;
-- industry jobs that vanish (a delivered job aged past ESI's include_completed
-- window) keep their terminal row is_current, matching the old table's behavior
-- of never sweeping completed jobs.

-- ── character_order → character_order_over_time + view ─────────────────────
alter table public.character_order rename to character_order_over_time;

-- Drop the existing primary key by its real name. This table was renamed from
-- market_order (see 20260702150000_endpoint_naming.sql), and renaming a table
-- leaves its PK constraint named after the original table — so the constraint is
-- market_order_pkey, not character_order_pkey. Look it up rather than guess.
do $$
declare cname text;
begin
  select conname into cname from pg_constraint
   where conrelid = 'public.character_order_over_time'::regclass and contype = 'p';
  if cname is not null then
    execute format('alter table public.character_order_over_time drop constraint %I', cname);
  end if;
end $$;
alter table public.character_order_over_time
  add column id bigint generated always as identity,
  add column is_current boolean not null default true,
  add column first_seen_at timestamptz not null default now(),
  add column last_seen_at timestamptz not null default now();
update public.character_order_over_time set first_seen_at = seen_at, last_seen_at = seen_at;
alter table public.character_order_over_time drop column seen_at;
alter table public.character_order_over_time add primary key (id);

drop index if exists public.character_order_character_id_issued_idx;
create index character_order_over_time_character_id_idx on public.character_order_over_time (character_id);
create unique index character_order_over_time_current_order_idx on public.character_order_over_time (order_id) where is_current;
create index character_order_over_time_order_id_idx on public.character_order_over_time (order_id, last_seen_at desc);

create view public.character_order with (security_invoker = on) as
  select * from public.character_order_over_time where is_current;

grant select on public.character_order to authenticated;

-- ── character_industry_job → character_industry_job_over_time + view ───────
alter table public.character_industry_job rename to character_industry_job_over_time;

-- Drop the existing primary key by its real name (renamed from industry_job, so
-- the constraint is industry_job_pkey). Look it up rather than guess.
do $$
declare cname text;
begin
  select conname into cname from pg_constraint
   where conrelid = 'public.character_industry_job_over_time'::regclass and contype = 'p';
  if cname is not null then
    execute format('alter table public.character_industry_job_over_time drop constraint %I', cname);
  end if;
end $$;
alter table public.character_industry_job_over_time
  add column id bigint generated always as identity,
  add column is_current boolean not null default true,
  add column first_seen_at timestamptz not null default now(),
  add column last_seen_at timestamptz not null default now();
update public.character_industry_job_over_time set first_seen_at = seen_at, last_seen_at = seen_at;
alter table public.character_industry_job_over_time drop column seen_at;
alter table public.character_industry_job_over_time add primary key (id);

drop index if exists public.character_industry_job_character_id_end_date_idx;
create index character_industry_job_over_time_character_id_idx on public.character_industry_job_over_time (character_id);
create unique index character_industry_job_over_time_current_job_idx on public.character_industry_job_over_time (job_id) where is_current;
create index character_industry_job_over_time_job_id_idx on public.character_industry_job_over_time (job_id, last_seen_at desc);

create view public.character_industry_job with (security_invoker = on) as
  select * from public.character_industry_job_over_time where is_current;

grant select on public.character_industry_job to authenticated;

-- ── corp_industry_job → corp_industry_job_over_time + view ─────────────────
alter table public.corp_industry_job rename to corp_industry_job_over_time;

-- Drop the existing primary key by its real name. Look it up rather than guess.
do $$
declare cname text;
begin
  select conname into cname from pg_constraint
   where conrelid = 'public.corp_industry_job_over_time'::regclass and contype = 'p';
  if cname is not null then
    execute format('alter table public.corp_industry_job_over_time drop constraint %I', cname);
  end if;
end $$;
alter table public.corp_industry_job_over_time
  add column id bigint generated always as identity,
  add column is_current boolean not null default true,
  add column first_seen_at timestamptz not null default now(),
  add column last_seen_at timestamptz not null default now();
update public.corp_industry_job_over_time set first_seen_at = seen_at, last_seen_at = seen_at;
alter table public.corp_industry_job_over_time drop column seen_at;
alter table public.corp_industry_job_over_time add primary key (id);

drop index if exists public.corp_industry_job_corporation_id_end_date_idx;
create index corp_industry_job_over_time_corporation_id_idx on public.corp_industry_job_over_time (corporation_id);
create unique index corp_industry_job_over_time_current_job_idx on public.corp_industry_job_over_time (job_id) where is_current;
create index corp_industry_job_over_time_job_id_idx on public.corp_industry_job_over_time (job_id, last_seen_at desc);

create view public.corp_industry_job with (security_invoker = on) as
  select * from public.corp_industry_job_over_time where is_current;

grant select on public.corp_industry_job to authenticated;
