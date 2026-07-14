-- Recreate every SCD Type 2 "current snapshot" view as `select *` so it exposes
-- the base table's real columns — including the validity window valid_from /
-- valid_until renamed in 20260713150000_rename_scd_validity_columns.sql.
--
-- That rename migration renamed the *_over_time columns first_seen_at →
-- valid_from and last_seen_at → valid_until and noted "views are select * and
-- update automatically" — true for a fresh schema.sql reset, where every view
-- below is `select * ... where is_current`. But the incrementally-migrated
-- databases had these views created with an *explicit* column list that aliased
-- the timestamps back (`valid_from as first_seen_at`, `valid_until as
-- last_seen_at`), so the rename never reached the view output: the base tables
-- moved to valid_from/valid_until while the views kept exposing
-- first_seen_at/last_seen_at. Any query selecting valid_from *from a view* (e.g.
-- the corpses page) then hit an unknown column, which PostgREST surfaces as an
-- error the caller reads as an empty result.
--
-- Recreate each view as the plain `select *` schema.sql already defines, closing
-- the drift so the views expose valid_from/valid_until directly. The views stay
-- security_invoker so RLS is still evaluated as the querying role against the
-- underlying *_over_time table. No object depends on these views (the asset-walk
-- SQL functions reference them by name but hold no catalog dependency), so a
-- drop/recreate is safe. SELECT is re-granted explicitly to preserve read access
-- for every role (drop clears the view's grants); row visibility is still gated
-- by the base tables' RLS.

drop view if exists public.character_asset;
create view public.character_asset with (security_invoker = on) as
  select * from public.character_asset_over_time where is_current;
grant select on public.character_asset to anon, authenticated, service_role;

drop view if exists public.character_blueprint;
create view public.character_blueprint with (security_invoker = on) as
  select * from public.character_blueprint_over_time where is_current;
grant select on public.character_blueprint to anon, authenticated, service_role;

drop view if exists public.character_order;
create view public.character_order with (security_invoker = on) as
  select * from public.character_order_over_time where is_current;
grant select on public.character_order to anon, authenticated, service_role;

drop view if exists public.character_industry_job;
create view public.character_industry_job with (security_invoker = on) as
  select * from public.character_industry_job_over_time where is_current;
grant select on public.character_industry_job to anon, authenticated, service_role;

drop view if exists public.character_clone;
create view public.character_clone with (security_invoker = on) as
  select * from public.character_clone_over_time where is_current;
grant select on public.character_clone to anon, authenticated, service_role;

drop view if exists public.character_ship;
create view public.character_ship with (security_invoker = on) as
  select * from public.character_ship_over_time where is_current;
grant select on public.character_ship to anon, authenticated, service_role;

drop view if exists public.corp_asset;
create view public.corp_asset with (security_invoker = on) as
  select * from public.corp_asset_over_time where is_current;
grant select on public.corp_asset to anon, authenticated, service_role;

drop view if exists public.corp_blueprint;
create view public.corp_blueprint with (security_invoker = on) as
  select * from public.corp_blueprint_over_time where is_current;
grant select on public.corp_blueprint to anon, authenticated, service_role;

drop view if exists public.corp_industry_job;
create view public.corp_industry_job with (security_invoker = on) as
  select * from public.corp_industry_job_over_time where is_current;
grant select on public.corp_industry_job to anon, authenticated, service_role;
