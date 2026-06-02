-- Store the player-assigned name of an asset (ship / container custom name).
-- Populated by the assets cron from ESI's /characters/{id}/assets/names/ for
-- singleton items; null for everything else.
alter table public.asset_over_time add column if not exists name text;

-- The asset view's `select *` was expanded into explicit columns at creation,
-- so recreate it to pick up the new column.
create or replace view public.asset with (security_invoker = on) as
  select * from public.asset_over_time where is_current;
