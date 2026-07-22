# PR 4: serve the CSVs at `/sheets/[file]` and cut the sheet over

## Goal

A public route the Google Sheet can `=IMPORTDATA()`. Structurally a copy of
`/esf/[file]` (`src/app/esf/[file]/route.ts`) — allowlist, ETag keyed on
`sde_build`, conditional-request handling, long CDN cache — with the response
shaped like the Sheets API endpoints (`text/csv`), minus their `api_token`
auth (this data is public SDE, identical for every caller).

## Route

`src/app/sheets/[file]/route.ts`:

- Allowlist = `SHEET_FILE_NAMES` (import from `src/buildSheetCsv.js` — one
  source of truth shared by encoder, job, and route; the ESF route's
  copy-pasted `Set` predates that option). Anything else → 404.
- Read the row from `sheet_csv` via `sdeSupabase()` (the same lazy anon
  client the ESF route uses — public-read RLS covers it; the route never
  needs the service role).
- Empty table (workflow hasn't run yet) → 404, same as ESF.
- `ETag: "<sde_build>-<file>"`, `Last-Modified` truncated to second
  precision, and the same `If-None-Match`/`If-Modified-Since` → 304 logic —
  lift it verbatim; if a third route ever needs it, extract a shared helper.
- `Cache-Control`: same policy as ESF
  (`public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800`) —
  the data changes at most nightly and only when CCP ships a build, browsers
  revalidate cheaply via 304, Vercel's CDN serves stale while revalidating.
  Note Google's IMPORTDATA fetcher caches on its own schedule (up to ~1h)
  regardless of headers; that's fine at this change cadence.
- Response headers: `Content-Type: text/csv; charset=utf-8` plus the caching
  set. `Content-Length` from the UTF-8 byte length (not `data.length` —
  type names contain non-ASCII).

No `dynamic`/`maxDuration` exports needed (single-row read; the per-user CSV
endpoints force-dynamic only because their content is per-token).

## Sheet cutover

Not a code change, but the point of the project — do it as this PR's rollout:

1. In the workbook, replace the pasted `StaticInputs` data with
   `=IMPORTDATA("https://<host>/sheets/static-inputs-twines.csv")` in `A1`
   (header row included — the current tabs have headers), and likewise
   `StaticOutputs` from `static-outputs-twines.csv`.
2. Verify the adjacent formula columns still compute (row ordering matches
   the old pastes; see README open question 4 on row shift across SDE
   builds).
3. If tabs exist for invention/types, point them at `invention.csv` /
   `types-twines.csv` the same way.

## Docs & bookkeeping (same PR)

- `CLAUDE.md`: add the `sheet-csv` npm script to Commands, `sheet_csv` to the
  table reference, `/sheets/[file]` to the routes table, and a line in the
  sde-mirror workflow bullet mentioning the `encodeSheets` tail step.
- `README.md` (repo): mention the endpoints if it lists public URLs.
- Update this directory's docs to Status: DONE as phases land (house style —
  see `docs/sde-db-cutover/`).

## Verification

- `curl -i` each of the seven filenames: 200, `text/csv`, sane body; unknown
  name → 404; repeat with `If-None-Match` → 304.
- `=IMPORTDATA(...)` from a scratch Google Sheet renders the header + rows
  with numbers parsed as numbers (raw, unformatted).
- After the next nightly `sde-mirror` run, the ETag flips only if the build
  changed content (`sde_build` stamp), and the CDN revalidates.
