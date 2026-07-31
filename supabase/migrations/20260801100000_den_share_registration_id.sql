-- Rename character_mercenary_den_share.character_id to registration_id —
-- step 6 of docs/registration-id-rename.md, and the LAST column rename in that
-- cleanup. Every table now names a registration uuid registration_id.
--
-- This one was held back from the den tables in #758 because those two are the
-- extract's data and this is the sharing preference on top of them; renaming
-- the share table there would have meant recreating the visibility helper mid
-- way through a migration whose subject was the view. Kept separate, it turns
-- out to be the smallest tranche of the lot.
--
-- What follows the rename by itself:
--
--   * the primary key (registration_id, alliance_id) — constraints are stored
--     as parse trees keyed on attnum;
--   * three of the four RLS policies on this table (owner read / insert /
--     delete). The fourth keys on alliance_id and never mentions the owner
--     column at all.
--
-- What does NOT follow, and is the only real work here:
--
--   * mercenary_den_shared_with_caller(), whose string body is re-parsed at
--     execution. It reads ONLY this table, so a bare rename would leave it
--     selecting sh.character_id and failing at its next call — and its next
--     call is an RLS policy evaluation on character_mercenary_den_over_time
--     and on mercenary_den_enemy_intel. A visibility helper that throws
--     doesn't degrade gracefully; every shared den and every piece of enemy
--     intel would error out of /mercenary-dens.
--
-- CREATE OR REPLACE is correct for it and no policy has to be dropped first:
-- the signature (reg_id uuid) and return type (boolean) are both unchanged, so
-- the two policies calling it keep their dependency intact. Contrast #749,
-- where the fitting helper's *signature* changed and the policies had to come
-- down first — and #754/#762, where a RETURNS TABLE column moved and the
-- function had to be dropped outright.

alter table public.character_mercenary_den_share rename column character_id to registration_id;

create or replace function public.mercenary_den_shared_with_caller(reg_id uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.character_mercenary_den_share sh
    where sh.registration_id = reg_id
      and sh.alliance_id in (select public.my_alliance_ids())
  );
$$;

grant execute on function public.mercenary_den_shared_with_caller(uuid) to authenticated;

-- Assert the column, the helper's body, and — the part worth guarding — that
-- the three owner policies followed the rename. If a policy predicate had NOT
-- been rewritten, the failure would be a silent privacy change rather than an
-- error: a policy still naming a dropped column raises at query time, which on
-- a permissive SELECT policy means the whole page fails rather than quietly
-- widening, but the insert/delete pair would start rejecting a user's own
-- writes. Cheaper to check here than to find out from the picker.
do $$
declare
  def text;
  bad text;
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'character_mercenary_den_share'
      and column_name = 'registration_id'
  ) then
    raise exception 'character_mercenary_den_share.registration_id is missing after the rename';
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'character_mercenary_den_share'
      and column_name = 'character_id'
  ) then
    raise exception 'character_mercenary_den_share still has a character_id column';
  end if;

  select pg_get_functiondef(p.oid) into def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'mercenary_den_shared_with_caller';

  if def is null then
    raise exception 'mercenary_den_shared_with_caller() is missing after the rename';
  end if;
  if def like '%sh.character_id%' then
    raise exception
      'mercenary_den_shared_with_caller() still references sh.character_id — every shared den and intel row would error on read';
  end if;
  if def not like '%sh.registration_id%' then
    raise exception 'mercenary_den_shared_with_caller() does not reference sh.registration_id';
  end if;

  -- Policy expressions are rewritten by the rename; verify rather than assume.
  select string_agg(polname, ', ') into bad
  from pg_policy
  where polrelid = 'public.character_mercenary_den_share'::regclass
    and pg_get_expr(coalesce(polqual, polwithcheck), polrelid) like '%character_id%';
  if bad is not null then
    raise exception 'policies still reference character_id after the rename: %', bad;
  end if;
end $$;
