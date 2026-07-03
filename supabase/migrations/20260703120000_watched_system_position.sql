-- Lets a user drag rows on /indexes to reorder their watch list, instead of it
-- always sorting alphabetically. Existing rows are backfilled in their
-- created_at order (oldest first) per user; watchSystem() assigns new rows
-- the next position, and the drag UI persists a full reorder in one request
-- via reorderWatchedSystems().
alter table public.watched_system add column if not exists position integer not null default 0;

update public.watched_system w
set position = ranked.rn
from (
  select user_id, system_id, row_number() over (partition by user_id order by created_at) - 1 as rn
  from public.watched_system
) ranked
where w.user_id = ranked.user_id and w.system_id = ranked.system_id;
