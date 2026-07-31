-- Rename character_id to registration_id on the two mercenary-den extract
-- tables — the second tranche of step 5 of docs/registration-id-rename.md.
--
-- character_mercenary_den_over_time (SCD identity/config) and
-- character_mercenary_den_status (append-only observations) move together
-- because the character_mercenary_den view joins both, and the status table's
-- RLS policy correlates the two on this very column. Splitting them would mean
-- recreating that view twice and leaving the correlation half-renamed in
-- between.
--
-- Deliberately NOT touched here: character_mercenary_den_share.character_id,
-- which is step 6. mercenary_den_shared_with_caller() reads the share table,
-- so its body stays valid across this migration — what it receives as an
-- argument is the den table's column, and the policy passing it is an
-- expression Postgres rewrites automatically.
--
-- Two dependent objects follow the rename by themselves and are listed here
-- only so the next person doesn't go looking for them:
--
--   * "Read status for visible mercenary dens" on the status table correlates
--     d.character_id = character_mercenary_den_status.character_id. Policy
--     expressions are stored as parse trees keyed on attnum, so both sides
--     re-point at the renamed column.
--   * "Alliance members read shared mercenary dens" passes the den table's
--     column straight into mercenary_den_shared_with_caller(...). Same reason.
--
-- The view does NOT follow, and is the whole reason this needs a migration
-- beyond the two ALTERs: its target list leads with `d.*`, which Postgres
-- expanded into explicit output columns when the view was created. After the
-- rename it would keep publishing character_id, and CREATE OR REPLACE VIEW
-- cannot rename an existing output column.

alter table public.character_mercenary_den_over_time rename column character_id to registration_id;
alter table public.character_mercenary_den_status    rename column character_id to registration_id;

alter index if exists public.character_mercenary_den_over_time_character_id_idx
  rename to character_mercenary_den_over_time_registration_id_idx;

drop view if exists public.character_mercenary_den;
create view public.character_mercenary_den with (security_invoker = on) as
  select
    d.*,
    s.state,
    s.development_level,
    s.development_amount,
    s.anarchy_level,
    s.anarchy_amount,
    s.infomorphs,
    s.reinforcement_end,
    s.observed_at as status_observed_at
  from public.character_mercenary_den_over_time d
  left join lateral (
    select state, development_level, development_amount, anarchy_level, anarchy_amount,
           infomorphs, reinforcement_end, observed_at
    from public.character_mercenary_den_status s
    where s.registration_id = d.registration_id and s.den_id = d.den_id
    order by s.observed_at desc
    limit 1
  ) s on true
  where d.is_current;

grant select on public.character_mercenary_den to authenticated;

-- Assert the recreated view rather than trusting the drop/create pair. The
-- lateral join's correlation is the part worth guarding: written against the
-- wrong column it would not error, it would just stop matching, and every den
-- would silently report null status — no state, no reinforcement timer — which
-- reads as "quiet" on a page whose entire job is showing which dens are under
-- attack.
do $$
declare
  n integer;
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'character_mercenary_den'
      and column_name = 'character_id'
  ) then
    raise exception 'view character_mercenary_den still publishes character_id after the rename';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'character_mercenary_den'
      and column_name = 'registration_id'
  ) then
    raise exception 'view character_mercenary_den does not publish registration_id';
  end if;

  -- The status columns must still be there; a botched lateral would drop them.
  select count(*) into n
  from information_schema.columns
  where table_schema = 'public' and table_name = 'character_mercenary_den'
    and column_name in ('state', 'development_level', 'anarchy_level', 'infomorphs',
                        'reinforcement_end', 'status_observed_at');
  if n <> 6 then
    raise exception 'view character_mercenary_den publishes % of 6 status columns — the lateral join did not survive', n;
  end if;
end $$;
