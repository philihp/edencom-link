-- A share link keeps opening a ship after it leaves the sharer's hangar, in
-- the state it was last seen: the ship page lists what was aboard at the
-- last extract that saw the hull. That is the one "children of this item"
-- query over closed rows, and the current-only partial index does not cover
-- it (a 35,000-row character scanned in ~550 ms; this index answers in
-- under a millisecond). Partial on the closed rows, so an insert (always
-- current) and a touch never write it; only closing a row does.
create index if not exists character_asset_version_history_location_idx
  on public.character_asset_version (location_id, valid_until desc)
  where not is_current;
