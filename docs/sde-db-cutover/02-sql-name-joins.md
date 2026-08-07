# PR 2 (medium): JOIN SDE names inside the Postgres functions

**Do this after the loader cutover (doc 01) has merged.** It's independent of
the loaders at runtime, but sequencing it second avoids two PRs fighting over
the same pages.

## Goal

Several Postgres functions return raw `type_id` / `location_id` /
`system_id` values that the app (or the user's spreadsheet) then has to
decorate. Now that fresh SDE data lives in the same database, those functions
can LEFT JOIN the `sde_*` views and return names directly. This has two
payoffs:

1. **The CSV / Google Sheets endpoints finally carry names.** Today
   `/api/character/assets`, `/api/character/blueprints`,
   `/api/character/orders`, `/api/character/jobs`, `/api/corp/assets`,
   `/api/corp/blueprints`, `/api/corp/jobs` emit bare ids — a spreadsheet user
   can't tell what item a row is. This is the single biggest win; do it first.
2. App pages/MCP tools can drop some app-side decoration passes later
   (follow-up simplification, not required in this PR).

## Ground rules

- **Additive columns only, appended at the END of each result row.** The CSV
  endpoints feed Google Sheets `IMPORTDATA` formulas that reference columns by
  position — inserting a column in the middle silently breaks users'
  spreadsheets. New name columns go last.
- Every function change is **dual-write**: `create or replace function` in a
  new migration under `supabase/migrations/` **and** the same change in
  `schema.sql`. Match each function's existing style (language sql/plpgsql,
  `security invoker`, explicit `grant execute … to authenticated` at the end —
  copy what's there).
- JOIN targets are the views, not the raw jsonb tables:
  - type names: `left join public.sde_published_type t on t.type_id = x.type_id`
  - system name + security: `left join public.sde_kspace_system s on s.system_id = x.system_id`
  - NPC station name/system: `left join public.sde_station st on st.station_id = x.location_id`
  - Always LEFT JOIN with the name possibly NULL — unpublished types,
    wormhole systems, and player structures won't match, and the caller's
    existing raw-id fallback must keep working.
- The views are `security_invoker` over RLS-enabled tables whose only policy
  is public SELECT — they are safe to reference from the existing
  SECURITY INVOKER functions for any caller, including `anon`.
- Player structures (`location_id` >= ~1_000_000_000_000) are NOT in the SDE —
  their names live in `universe_structure` / `corp_structure` (already in
  `public`). Joining those too is allowed where a function already has the
  RLS context for it, but keep scope tight: SDE joins are the point of this
  PR.

## Work list, in priority order

For each function: read its current definition in `schema.sql` (the
authoritative copy), find the migration that last touched it for style, and
append the new output columns.

1. **CSV snapshot functions** (all return JSON consumed by
   `src/app/api/{character,corp}/*/route.ts`, which converts to CSV via
   `toCsv` — appended JSON keys become appended CSV columns; verify `toCsv`
   preserves key order from the first row):
   - `character_asset_snapshot_at(character_ids, as_of)` → add `type_name`.
   - `character_blueprints(character_ids)` → add `type_name` (the blueprint's
     own type).
   - `character_orders(character_ids, as_of)` → add `type_name`.
   - `character_industry_jobs(character_ids, include_delivered, as_of)` → add
     `blueprint_type_name` and `product_type_name` (join
     `sde_published_type` twice — industry job rows carry blueprint and
     product type ids; check the exact column names in the function body).
   - `corp_assets(character_ids)` → add `type_name`.
   - `corp_blueprints(character_ids)` → add `type_name`.
   - `corp_industry_jobs(character_ids, include_delivered, as_of)` → same two
     names as the character variant.
2. **Asset search**: `character_asset_search(type_ids)` and
   `corp_asset_search(type_ids)` → add `type_name`, and where the row carries
   a root NPC station id, `root_location_name` + `system_id` via
   `sde_station`. This lets `/asset/search` skip part of its
   `resolveLocations` pass later.
3. **`asset_ancestors(start_id)`** → add `type_name` per ancestor row (feeds
   the `assetPath.tsx` breadcrumb).
4. _(Optional, only if cheap)_ `character_asset_location_summary()` /
   `corp_asset_location_summary()` → station name/system for NPC-station
   roots.

Do NOT rework the app pages/MCP tools to consume the new columns in this PR —
land the SQL additively, verify the endpoints, and leave consumer
simplification for a small follow-up. (Exception: if a page change is
literally deleting a now-redundant `fetchTypeNames` call with no other
restructuring, it may ride along.)

## Verification

- `pnpm run lint` && `pnpm run build`.
- Apply the migration to a dev/branch database (`pnpm run db:push`), then:
  - `select * from character_asset_snapshot_at(array[...]::uuid[], now()) limit 3;`
    — new keys present, existing keys in unchanged order.
  - Hit each CSV endpoint with a valid `api_token` and diff the header row
    against production: identical except new columns at the end.
  - `/asset/search` and an asset breadcrumb page still render.
- Confirm an id with no SDE match (a player structure location, an
  unpublished type) yields NULL/empty-string name and the UI/CSV still shows
  the raw id.

## Follow-up candidates (note in the PR description, don't do)

- Pages dropping `fetchTypeNames` where the RPC now returns names.
- MCP tools reading names from the RPCs instead of decorating.
- `resolveLocations` slimming down for NPC-station roots.
