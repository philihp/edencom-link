-- ── goonwiki_page ─────────────────────────────────────────────────────────
-- The cleared pages of the rewritten Goon wiki (docs/goonwiki-lookup.md),
-- one row per page, for the admin-only MCP tools search_wiki and
-- read_wiki_page. Written only by `pnpm run goonwiki-import`, from the
-- folder of cleared Markdown pages on the owner's machine. The raw MediaWiki
-- export never comes here.
--
-- PRIVATE. No web page, route, sitemap or link reads this table. RLS is on
-- with no policy, and anon/authenticated hold no grant on the table or on the
-- search function, so the only reader is the service role, which the MCP
-- tools use only after isChancellor() said yes.
create table public.goonwiki_page (
  -- The page's path in the cleared folder, less `.md`: `geography/c-lp3n`,
  -- `history/alliances/fidelas-constans`. A path, not a title, because one
  -- name can be a page in two sections.
  slug         text primary key check (slug ~ '^[a-z0-9][a-z0-9._/-]*$'),
  title        text not null,
  -- Markdown, without the front matter; links to other pages are written
  -- `wiki:<slug>` by the import.
  body         text not null,
  -- When the import last wrote a different title or body.
  updated_at   timestamptz not null default now(),
  -- What the import compares, so a re-run downloads no bodies to find what
  -- changed. Generated, so it can never disagree with the row.
  content_hash text generated always as (md5(title || E'\n' || body)) stored,
  -- The title outranks the body.
  search       tsvector generated always as (
                 setweight(to_tsvector('english', title), 'A') ||
                 setweight(to_tsvector('english', body), 'B')
               ) stored
);
create index goonwiki_page_search_idx on public.goonwiki_page using gin (search);

alter table public.goonwiki_page enable row level security;
revoke all on public.goonwiki_page from public, anon, authenticated;
grant select, insert, update, delete on public.goonwiki_page to service_role;

-- Ranked full-text search: websearch syntax ("quoted phrase", -word, or),
-- best first, ties by slug so the order is deterministic. The rank is
-- ts_rank_cd scaled down for long pages (normalization 1, so a 400 KB archive
-- does not win on bulk alone), plus 1 when the title itself matches: a page
-- named for what was asked comes first. The snippet is cut
-- only for the rows returned, since ts_headline reads the whole body.
create or replace function public.goonwiki_search(query text, row_limit int default 10)
returns table (slug text, title text, snippet text, rank real)
language sql
stable
set search_path = public, pg_temp
as $$
  with q as (select websearch_to_tsquery('english', query) as tsq),
  hits as (
    select p.slug, p.title, p.body, (ts_rank_cd(p.search, q.tsq, 1) + (to_tsvector('english', p.title) @@ q.tsq)::int)::real as rank, q.tsq
    from public.goonwiki_page p, q
    where p.search @@ q.tsq
    order by rank desc, p.slug
    limit greatest(1, least(coalesce(row_limit, 10), 50))
  )
  select h.slug,
         h.title,
         ts_headline('english', h.body, h.tsq,
           'MaxFragments=2, MinWords=8, MaxWords=24, FragmentDelimiter=" … ", StartSel=**, StopSel=**'),
         h.rank
  from hits h
  order by h.rank desc, h.slug
$$;
revoke execute on function public.goonwiki_search(text, int) from public, anon, authenticated;
grant execute on function public.goonwiki_search(text, int) to service_role;
