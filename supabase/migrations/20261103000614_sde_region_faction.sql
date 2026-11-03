-- sde_region gains faction_id: the empire a region belongs to in the SDE
-- (sde_map_regions.data.factionID, present on 36 of the ~70 k-space regions
-- — every highsec region and the pirate nullsec homelands; null on the
-- sovereign-null and no-man's regions). Ship memory's highsec lingo keys on
-- it (docs/ship-memory.md "Acquired accents" → "Ships in highsec"), reading
-- it through src/sdeRegions.ts getSdeRegionFactions.
--
-- create or replace keeps the view's grants and security_invoker, and adding a
-- column at the end is the one view change Postgres allows in place.
create or replace view public.sde_region
with (security_invoker = true) as
select
  _key as region_id,
  data -> 'name' ->> 'en' as name,
  (data ->> 'factionID')::bigint as faction_id
from public.sde_map_regions
where _key >= 10000000
  and _key < 11000000
  and coalesce(trim(data -> 'name' ->> 'en'), '') <> '';
