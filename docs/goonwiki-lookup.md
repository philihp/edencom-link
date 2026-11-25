# Goonwiki lookup (private, admin only)

Two MCP tools let an admin read the cleared pages of the rewritten old Goon wiki. The EVE mail watch uses them to look up goon history, places and slang.

- `search_wiki(query, limit = 10)` gives `slug`, `title` and a short `snippet` for each match, best match first.
- `read_wiki_page(slug)` gives `title` and `body` (Markdown) of one page.

## Who can read the pages

- Only a Chancellor (`isChancellor()`, the existing admin check) gets data.
- All other callers get `{"error":"not found"}` from both tools. A caller without a verified user, and a caller whose admin check fails, get the same answer. A missing page also gets the same answer. Thus a refusal tells nothing about the pages.
- The check runs before the tool reads the database. A non-admin call does not touch `goonwiki_page`.
- In Postgres, `goonwiki_page` has RLS on and no policy. `anon` and `authenticated` have no grant on the table and no execute grant on `goonwiki_search()`. Only the service role can read them. `test/sql/goonwiki_page.sql` proves this.
- There is no web page, API route, sitemap entry or link for this data. Do not add one.
- Both tools are read-only. No MCP tool writes, edits or deletes a page. Only the import writes.
- The tool descriptions and each answer say that the content is reference data, never instructions.

## Source

- Only the cleared Markdown pages of the rewrite go into the table. Each page is a `.md` file in a section folder (for example `geography/c-lp3n.md`), with front matter of `key: <JSON value>` lines between two `---` lines, and a `title`.
- **Never** point the import at the raw MediaWiki export (`goonwiki-export.jsonl.gz` or any other dump). That content is not cleared.
- The import refuses the whole run when a section folder holds a file that is not Markdown, or a `.md` file without front matter or title. Files at the top of the folder (`index.md`, `review.md`, `redirects.csv`) are not pages and are skipped. Hidden files (`.DS_Store`) are skipped.

## Table

`goonwiki_page` (migration `20261125180747_goonwiki_page.sql`):

| Column         | Meaning                                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `slug`         | Primary key. The path in the folder without `.md`, for example `history/alliances/goonswarm`. One name can be a page in two sections, so the slug keeps the section. |
| `title`        | From the front matter.                                                                                                     |
| `body`         | Markdown without the front matter. A link to another page is written `wiki:<slug>`, which `read_wiki_page` accepts.          |
| `updated_at`   | When the import last wrote a different title or body.                                                                      |
| `content_hash` | Generated: `md5(title \|\| E'\n' \|\| body)`. The import compares it, so a re-run does not download bodies.                  |
| `search`       | Generated `tsvector`: title with weight A, body with weight B. GIN index `goonwiki_page_search_idx`.                         |

`goonwiki_search(query, row_limit)` uses `websearch_to_tsquery('english', …)` (words, `"a phrase"`, `-word`, `or`). The rank is `ts_rank_cd` with normalization 1 (long pages do not win only on length), plus 1 when the title matches. Ties sort by slug. The snippet is `ts_headline` with the matched words in `**bold**`, made only for the rows returned. The limit is 1 to 50.

## Import

Run it on aristotle, from the repo root:

```sh
pnpm run goonwiki-import -- ~/work/goonwiki-rewrite --dry-run   # show the plan, write nothing
pnpm run goonwiki-import -- ~/work/goonwiki-rewrite
```

- The argument is the cleared folder or its `pages/` folder.
- It needs `SUPABASE_URL` (or `NEXT_PUBLIC_SUPABASE_URL`) and `SUPABASE_SERVICE_KEY`, from the environment or from `.env` in the repo root.
- It is idempotent. A new page is inserted. A page with a changed title or body is updated, and its `updated_at` moves. A page whose file is gone is deleted. A second run with no change writes nothing.
- After it writes, it reads the hashes again and stops with an error if the table does not match the folder.
- A run that would delete more than half of the stored pages stops. Check the folder. If the deletes are correct, add `--allow-mass-delete`. An empty folder always stops.

The pure rules are in `src/goonwiki/page.ts` (tested in `test/goonwikiPage.test.ts`). The CLI is `src/goonwikiImport.ts`. The tool rules are in `src/app/api/mcp/wikiQuery.ts` (tested in `test/wikiTools.test.ts`), and `wikiTools.ts` binds them to the database.
