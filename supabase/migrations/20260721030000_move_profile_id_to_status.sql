-- Move profile_id off corp_structure into the own-corp-only corp_structure_status
-- table, exactly like fuel_expires was split out (20260720060000). corp_structure
-- itself is readable by alliance-mates, but a structure's reinforcement profile is
-- private intel that shouldn't leak past the owning corp — parking it in
-- corp_structure_status keeps it behind that table's own-corps-only RLS policy.
alter table public.corp_structure_status add column if not exists profile_id bigint;

-- Backfill from corp_structure before dropping the column there.
update public.corp_structure_status s
  set profile_id = c.profile_id
  from public.corp_structure c
  where c.structure_id = s.structure_id;

alter table public.corp_structure drop column if exists profile_id;
