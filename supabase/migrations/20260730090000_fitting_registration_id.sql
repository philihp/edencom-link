-- Rename the fitting tables' owner column from character_id to registration_id.
--
-- It has always held registration(id) — a uuid — never the EVE numeric
-- character id. The sibling character_* extract tables carry the same
-- misnomer, but those are far more widely referenced; the two fitting tables
-- are young enough to fix, and fixing them is what lets `character_id` mean
-- the EVE id in the /fitting/[characterId]/[fittingId] route without the two
-- senses colliding inside one page. See the id naming note in CLAUDE.md.
--
-- Order matters here. A rename propagates automatically to indexes,
-- constraints and RLS policy expressions (Postgres stores those as parsed
-- trees keyed on attnum), but NOT to:
--   * the character_fitting view — `select *` was expanded to explicit output
--     columns at creation, so the view would keep publishing the old name;
--     it has to be dropped and recreated.
--   * fitting_shared_with_caller() — a classic string-body SQL function, so
--     its body is re-parsed at execution and would fail on the missing column
--     with nothing to warn us at migration time. It has to be recreated too,
--     and its dependent policy dropped first (also so the policy's own call
--     re-binds to the new parameter names).

drop policy if exists "Audience reads shared fittings" on public.character_fitting_over_time;
drop function if exists public.fitting_shared_with_caller(uuid, bigint);
drop view if exists public.character_fitting;

alter table public.character_fitting_over_time rename column character_id to registration_id;
alter table public.character_fitting_share     rename column character_id to registration_id;

alter index if exists public.character_fitting_over_time_character_id_idx
  rename to character_fitting_over_time_registration_id_idx;

-- Recreated verbatim apart from the column name; still security_invoker, so
-- the owner policy and the widening policy below both apply through it.
create view public.character_fitting with (security_invoker = on) as
  select * from public.character_fitting_over_time where is_current;

grant select on public.character_fitting to authenticated;

create function public.fitting_shared_with_caller(registration_id uuid, fitting_id bigint)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.character_fitting_share s
    left join public.character_directory owner on owner.registration_id = s.registration_id
    where s.registration_id = fitting_shared_with_caller.registration_id
      and s.fitting_id = fitting_shared_with_caller.fitting_id
      and (
        s.level = 'public'
        or (s.level = 'corporation' and owner.corporation_id in (select public.my_corporation_ids()))
        or (s.level = 'alliance' and owner.alliance_id in (select public.my_alliance_ids()))
      )
  );
$$;

grant execute on function public.fitting_shared_with_caller(uuid, bigint) to authenticated;

create policy "Audience reads shared fittings"
  on public.character_fitting_over_time
  for select
  to authenticated
  using (public.fitting_shared_with_caller(registration_id, fitting_id));
