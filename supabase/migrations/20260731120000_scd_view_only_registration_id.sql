-- Rename character_id to registration_id on the three SCD families whose only
-- dependent object is their own is_current view — the first tranche of step 5
-- of docs/registration-id-rename.md.
--
-- character_ship_over_time, character_skill_over_time and
-- character_clone_over_time are batched together for the same reason the seven
-- flat tables were in 20260730200000: each rename PR costs one window where the
-- deployed code and the schema disagree, that cost is per-PR rather than per
-- table, and none of these three can fail in an interesting way. Their indexes
-- and RLS policies follow the rename by themselves (Postgres keys those on
-- attnum), and the one thing that doesn't follow — the view — is identical in
-- all three cases.
--
-- The rest of the SCD families are deliberately NOT here. Every one of them
-- has a function reading the table or the view on top of the view itself
-- (character_orders(), character_industry_jobs(), character_blueprints(), and
-- the four around assets), and a string-body SQL function that still names a
-- renamed column fails at its next call rather than at migration time. Those
-- need their own PRs, recreating each function in the right order.
--
-- Why the views must be dropped rather than replaced: `create view v as
-- select * from t` expands the star into an explicit target list at creation
-- time, freezing the view's own output column names. After a base-column
-- rename the view keeps publishing `character_id`, and `create or replace
-- view` cannot rename an existing output column either.

alter table public.character_ship_over_time  rename column character_id to registration_id;
alter table public.character_skill_over_time rename column character_id to registration_id;
alter table public.character_clone_over_time rename column character_id to registration_id;

alter index if exists public.character_ship_over_time_character_id_idx
  rename to character_ship_over_time_registration_id_idx;
alter index if exists public.character_skill_over_time_character_id_idx
  rename to character_skill_over_time_registration_id_idx;
alter index if exists public.character_clone_over_time_character_id_idx
  rename to character_clone_over_time_registration_id_idx;

-- Recreated verbatim apart from the base column now being registration_id.
-- Each is still `select *`, so the view's column order keeps matching the
-- table's — which character_clone_over_time depends on, since system_id was
-- appended last specifically so a fresh schema.sql reset and an incrementally
-- migrated database expose the same order through character_clone.
drop view if exists public.character_ship;
create view public.character_ship with (security_invoker = on) as
  select * from public.character_ship_over_time where is_current;
grant select on public.character_ship to authenticated;

drop view if exists public.character_skill;
create view public.character_skill with (security_invoker = on) as
  select * from public.character_skill_over_time where is_current;
grant select on public.character_skill to authenticated;

drop view if exists public.character_clone;
create view public.character_clone with (security_invoker = on) as
  select * from public.character_clone_over_time where is_current;
grant select on public.character_clone to authenticated;

-- The rename is only half the job: it moves the column but leaves nothing to
-- catch a view that silently kept the old name (dropping and recreating is
-- easy to get wrong when three views differ only by table). Assert the shape
-- both ways, so a view that still publishes character_id, or one whose star
-- expansion lost registration_id, fails here rather than at the next page
-- render.
do $$
declare
  v text;
begin
  foreach v in array array['character_ship', 'character_skill', 'character_clone'] loop
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = v and column_name = 'character_id'
    ) then
      raise exception 'view public.% still publishes character_id after the rename', v;
    end if;
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = v and column_name = 'registration_id'
    ) then
      raise exception 'view public.% does not publish registration_id', v;
    end if;
  end loop;
end $$;
