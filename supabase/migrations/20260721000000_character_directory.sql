-- Stage A of the sharing layer (docs/sharing-layer/design.md): the public
-- character directory.
--
-- Splits public EVE identity out of the owner-only `registration` table into a
-- world-readable directory, so the sharing layer can resolve a shared row's
-- owner (name / corp / alliance) with a plain RLS join instead of a SECURITY
-- DEFINER bridge. The directory carries NO user_id — that would let anyone
-- correlate a user's alts — which is exactly why registration stays private.
--
-- Named character_directory because "character" is a SQL reserved word (and to
-- stay distinct from the character_* extract tables, which are owned data). It
-- is "the character directory" in the design doc.
--
-- Populated by the character-directory extract job, which subsumes the retired
-- character-affiliations job: one POST /characters/affiliation/ pull now feeds
-- character_affiliation (unchanged), registration.corporation_id (unchanged),
-- the corporation/alliance name+alliance_id rows, and this directory.

-- Names are backfilled from a bulk universe/names lookup that can lag an
-- affiliation pull by a run; a directory keyed by id must still record the id
-- when the name misses (and corporation.alliance_id FKs to alliance, so the
-- alliance row has to exist even before its name resolves).
alter table public.alliance alter column name drop not null;
alter table public.corporation alter column name drop not null;

create table public.character_directory (
  character_id bigint primary key,
  name text,
  corporation_id bigint,
  alliance_id bigint,
  registration_id uuid unique references public.registration (id) on delete set null,
  updated_at timestamptz not null default now()
);
create index character_directory_corporation_id_idx on public.character_directory (corporation_id);

alter table public.character_directory enable row level security;
create policy "Everyone reads the character directory"
  on public.character_directory
  for select
  to anon, authenticated
  using (true);

grant select on public.character_directory to anon, authenticated;
grant all    on public.character_directory to service_role;
