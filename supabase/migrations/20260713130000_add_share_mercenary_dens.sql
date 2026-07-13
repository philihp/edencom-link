-- Per-user opt-in to share deployed mercenary dens
-- (character_mercenary_den) with corpmates. Toggled from the top of the
-- /mercenary-dens page. Non-destructive: defaults to false (private), so
-- existing rows keep dens unshared.
alter table public.user_settings
  add column if not exists share_mercenary_dens boolean not null default false;
