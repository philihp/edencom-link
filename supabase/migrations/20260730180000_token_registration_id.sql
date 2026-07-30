-- Rename token.character_id to registration_id — step 1 of
-- docs/registration-id-rename.md.
--
-- The column has always held registration(id), a uuid, never the EVE numeric
-- character id. `token` goes first because it's the smallest such table with
-- the largest downstream effect: forEachCharacter (src/jobs/lib.js) selects
-- from it to build the argument object every extract job destructures, so the
-- misnomer propagates outward from here.
--
-- Unusually for this cleanup, nothing else in the database has to move with
-- it. No view selects from token, no function references it, and its RLS
-- policy gates on user_id rather than the owner column — so the rename carries
-- the FK, the unique constraint and both indexes along by itself. (Contrast
-- the fitting tables in #749, where a view and a SQL function both had to be
-- recreated by hand.) The constraint and index are renamed only so their names
-- keep describing their columns.

alter table public.token rename column character_id to registration_id;

alter index if exists public.token_character_id_idx rename to token_registration_id_idx;

-- Guarded because the constraint's name depends on how it was originally
-- created; schema.sql declares it inline, which Postgres auto-names
-- token_character_id_key. There is no `rename constraint if exists`.
do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conname = 'token_character_id_key'
      and conrelid = 'public.token'::regclass
  ) then
    alter table public.token rename constraint token_character_id_key to token_registration_id_key;
  end if;
end $$;
