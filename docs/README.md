# docs/ — project index

Every entry here is a project: either a staged plan (a directory of numbered,
self-contained PR specs with its own README) or a single-file plan/spec. This
index records what each one is and where it stands. Statuses: ✅ **complete**,
🔨 **in progress**, 📋 **planned** (nothing built yet). Keep this table
honest when a project ships or a new doc lands.

## Complete

| Project | What it was | Notes |
|---|---|---|
| [appraisals/](appraisals/) | ISK appraisals via innomin.at: `appraise_items`/`appraise_assets` MCP tools, asset-viewer appraisal with row selection | All five docs shipped; doc 05's selection UI superseded doc 03's per-row column. Future ideas parked in its README |
| [cron-to-workflows/](cron-to-workflows/) | Move every extract job (scheduled and on-demand) onto Vercel Workflows | All phases done; the crons are thin `start()` triggers. Aftercare tracked in its doc 06 |
| [fluid-compute-memory-plan/](fluid-compute-memory-plan/) | Reduce Vercel Fluid Compute memory costs | Closed out by #695 (streamed SDE ingest, compact asset reconciles, `job.peak_rss` metric), not by working the staged plan. The plan's premise expired one day before it merged: #676 removed the `memory` settings from `vercel.json`, so under active-CPU billing there is no memory dial left to turn down. Remaining phases deliberately unworked — see its README |
| [fittings.md](fittings.md) | Read-only saved-fitting extract + `/fitting` page + MCP `list_fittings` | Shipped as #742–#745. ESI has no corp/alliance fittings endpoint — the doc explains why |
| [gice-auth.md](gice-auth.md) | GICE (Goonfleet OIDC) as an auth method, hand-rolled auth-code client | Live; doubles as the reference for how the flow works |
| [sde-db-cutover/](sde-db-cutover/) | Stop downloading the SDE at build time; read the nightly-mirrored `sde_*` tables at runtime | Docs 00–04 all done, including the esf-data move into the `sde-mirror` workflow tail |
| [sharing-layer/](sharing-layer/) | Unified recursive asset shares + folding fitting/den shares into one audience model + Lenses | Docs 01–07 all done; the `/lens` editor sits behind the `lens` dark-launch flag |
| [sheet-csv/](sheet-csv/) | Nightly industry CSVs from the SDE mirror, served at `/sheets/[file]` for `=IMPORTDATA()` | Runs as a tail step of the `sde-mirror` workflow |

## In progress

| Project | What it is | Where it stands |
|---|---|---|
| [discord-bot/](discord-bot/) | Discord sign-in + a bot posting alerts to configured channels | Stages 01–05 and 07 shipped (legal pages, interactions endpoint, `/edencom link`, reinforcement detection, notification sender, low-fuel alerts — the alert loop is closed and proven to carry a second source). Only stage 06 (Discord sign-in) is left, folded into [open-registration.md](open-registration.md)'s stage 5 |
| [jobs-page.md](jobs-page.md) | `/jobs`: one page for job freshness, live activity, next scheduled run; replaces `/character/refresh` | `/jobs` page exists but renders stub data (`src/app/jobs/stubData.ts`); the real queries and the `/character/refresh` replacement are still to come |
| [mcp-search-exploration.md](mcp-search-exploration.md) | MCP static-data exploration tools (planets, regions, type taxonomy) | DB views + the planet slice shipped (`list_planets`, `sdeRegions.ts`); type-taxonomy tools (`get_type`, `list_item_groups`, `list_types`), `explore_region`, and PR 4 still open |
| [mcp-tools-spec.md](mcp-tools-spec.md) | Tool gaps found by real MCP sessions: blueprint scoping, structures, readiness | §1 `list_blueprints`/`blueprint_search` and §3 `list_structures` shipped; §2 `research_backlog` and §4 `build_readiness` not built |
| [ntfy-notifications.md](ntfy-notifications.md) | Industry-job completion pushes via ntfy.sh | The `notification` outbox table landed (amended with a `transport` discriminator) and the Discord transport ships via discord-bot stages 04–05; the ntfy transport and the industry-page opt-in toggle are not built |
| [page-load-performance.md](page-load-performance.md) | Fix dead-feeling navigations to heavy pages | Phase A (navigation feedback) largely shipped — `loading.tsx` now covers the heavy routes; the payload-reduction phases remain per the doc |
| [registration-id-rename.md](registration-id-rename.md) | Rename the columns where `character_id` actually holds a registration uuid | Step 1 done (`token.registration_id`); the rest is staged and deliberately unhurried — naming is wrong, not broken |

## Planned

| Project | What it will be | Notes |
|---|---|---|
| [asset-proximity/](asset-proximity/) | Sort `/asset` by stargate jumps from the main character's location | Feasibility validated (the SDE stargate graph is mirrored); no code yet |
| [custom-fit-ui.md](custom-fit-ui.md) | Replace `@eveshipfit/react` rendering with our own components, keeping the dogma-engine math | Stage 0 (proof-out) done — decoder, engine glue, flag mapping and skills all verified; stages 1–5 not started |
| [fitting-paging.md](fitting-paging.md) | Treat the game's 500-fit cap as a resident set and this site as the backing store (page fits in/out via ESI) | Plan only; builds on the shipped fittings feature |
| [open-registration.md](open-registration.md) | Drop the invite-code gate: anonymous users on first visit, invites become referral attribution, identities (email / EVE SSO / Discord / GICE) affix in any order | Plan merged 2026-08-12 (#860); implementation not started. Its stage 5 delivers discord-bot stage 06 |
