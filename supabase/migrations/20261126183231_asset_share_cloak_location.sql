-- Cloak the location of a shared item (character_asset_share.cloak_location).
-- The pages and the share card then say "Location cloaked" where they would
-- say where the item sits, and leave out the chain of containers and ships
-- above it. Additive and defaulted, so every existing share keeps drawing as
-- it did.
alter table public.character_asset_share
  add column if not exists cloak_location boolean not null default false;

comment on column public.character_asset_share.cloak_location is
  'Show "Location cloaked" in place of where the item is, and no ship or container above it. App-enforced, like show_as_main.';
