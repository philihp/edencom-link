-- Owner is now optional on hand-reported enemy-den sightings (the reporter may
-- not know who owns the den). The alliance column is left in place but no longer
-- written by the app.
alter table public.mercenary_den_enemy_intel alter column owner drop not null;
