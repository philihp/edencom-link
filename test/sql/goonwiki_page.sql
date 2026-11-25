-- SQL-level coverage for goonwiki_page and goonwiki_search()
-- (docs/goonwiki-lookup.md): the rules Postgres enforces rather than the app.
--
--   * search finds a known page, title hits ranked before body hits, with a
--     snippet; the order is deterministic;
--   * content_hash is md5(title || E'\n' || body), what the import compares;
--   * anon and authenticated can neither read the table nor call the search,
--     even under Supabase's default grants: only the service role can.
--
-- The migration is read as it stands (\ir), so the test cannot drift from it.
-- Run against a THROWAWAY database from the repo root: DATABASE_URL='postgresql://…/throwaway'
-- pnpm run test:sql. Everything runs in one transaction and rolls back.
begin;

do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin; exception when duplicate_object then null; end $$;
-- As on Supabase: the service role passes RLS (rolled back with the rest).
alter role service_role bypassrls;

-- What Supabase hands every new table and function: the migration must take
-- it back.
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

\ir ../../supabase/migrations/20261125180747_goonwiki_page.sql

insert into public.goonwiki_page (slug, title, body) values
  ('geography/c-lp3n', 'C-LP3N',
   '# C-LP3N' || E'\n\n' || 'One time staging system and market hub of former Imperium ally Fidelas Constans.'),
  ('glossary/staging', 'Staging', '# Staging' || E'\n\n' || 'The system a fleet lives in.'),
  ('glossary/blob', 'Blob', '# Blob' || E'\n\n' || 'A very large fleet.');

-- ── Search, as the service role ──────────────────────────────────────────
set local role service_role;

do $$
declare
  hits text[];
  snip text;
begin
  select array_agg(slug order by rank desc, slug) into hits from public.goonwiki_search('staging', 10);
  assert hits = array['glossary/staging', 'geography/c-lp3n'],
    format('a title hit should rank first: %s', hits);

  select snippet into snip from public.goonwiki_search('market hub', 10) where slug = 'geography/c-lp3n';
  assert snip like '%**market** **hub**%', format('the snippet should mark the words: %s', snip);

  select array_agg(slug) into hits from public.goonwiki_search('"staging system" -blob', 10);
  assert hits = array['geography/c-lp3n'], format('websearch syntax: %s', hits);

  select array_agg(slug) into hits from public.goonwiki_search('fleet', 1);
  assert cardinality(hits) = 1, 'row_limit should cap the answer';

  assert not exists (select 1 from public.goonwiki_search('nothingmatchesthis', 10)), 'no match, no rows';
end $$;

do $$
begin
  assert (select content_hash from public.goonwiki_page where slug = 'glossary/blob')
       = md5('Blob' || E'\n' || '# Blob' || E'\n\n' || 'A very large fleet.'),
    'content_hash must be md5(title || newline || body)';
end $$;

-- A removed page is gone from the search at once.
delete from public.goonwiki_page where slug = 'glossary/staging';
do $$
begin
  assert not exists (select 1 from public.goonwiki_search('staging', 10) where slug = 'glossary/staging'),
    'a deleted page must not be found';
end $$;

reset role;

-- ── Nobody else reads it ─────────────────────────────────────────────────
set local role authenticated;
do $$
begin
  perform 1 from public.goonwiki_page;
  raise exception 'authenticated read goonwiki_page';
exception when insufficient_privilege then
  null;
end $$;
do $$
begin
  perform 1 from public.goonwiki_search('staging', 10);
  raise exception 'authenticated called goonwiki_search';
exception when insufficient_privilege then
  null;
end $$;
do $$
begin
  insert into public.goonwiki_page (slug, title, body) values ('misc/x', 'x', 'x');
  raise exception 'authenticated wrote goonwiki_page';
exception when insufficient_privilege then
  null;
end $$;
reset role;

set local role anon;
do $$
begin
  perform 1 from public.goonwiki_page;
  raise exception 'anon read goonwiki_page';
exception when insufficient_privilege then
  null;
end $$;
do $$
begin
  perform 1 from public.goonwiki_search('staging', 10);
  raise exception 'anon called goonwiki_search';
exception when insufficient_privilege then
  null;
end $$;
reset role;

rollback;
