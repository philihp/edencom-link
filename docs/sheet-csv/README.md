# Static industry CSVs: nightly build from the SDE mirror, served as CSV

## What this is

A colleague's Python script (`full_sheet_gen.py`, kept for reference as
[`reference/full_sheet_gen.py`](reference/full_sheet_gen.py)) reads SDE YAML
files and writes CSVs that feed an industry-planning Google Sheet (the
"Cuddles" workbook). Today someone has to download the SDE, run the script by
hand, and paste the output into the sheet's static tabs.

This project makes it a nightly pipeline: port the transform to JavaScript,
run it as a tail step of the existing `sde-mirror` Vercel Workflow (so it
regenerates whenever CCP ships an SDE build), store the CSVs in a Supabase
table, and serve them from public routes that the sheet can `=IMPORTDATA()`
directly — replacing the manual paste entirely.

## Endpoints (the deliverable)

The sheet's two static tabs define the target shape. Sample exports of those
tabs show the generated payload is their **leading columns**; everything to
the right is sheet-side formulas we don't produce:

- **StaticInputs** — `Group,Type,Material,InputQty`: one row per material of
  every buildable item. This is the Python's `inputs.csv` **plus a `Group`
  column** (the tech-level label the Python only emitted into `types.csv`,
  which the sheet then joined in with lookups — we pre-join it, so the
  `#N/A` rows visible in the sheet export can't happen).
- **StaticOutputs** — `Group,Type,OutputQty,JobTime`: one row per buildable
  item. The Python's `outputs.csv`, same pre-joined `Group` column.

Plus two secondary files the script also derives (same transform pass, nearly
free to keep):

- **invention.csv** — invention outcomes (datacores, base runs, probability)
- **types.csv** — every referenced type id with group label and volume (the
  sheet may keep using it for volume lookups; the Group join above makes it
  optional for grouping)

The Python's `--mode twines|miros` flag changes only the group labeling
(`miros` labels groupIDs 334/873/913 as `Component`). The sample workbook is
`twines`-mode (no `Component` rows). Mode now affects three of the four files
(everything carrying a `Group` column or labels), so files are precomputed
per mode rather than parameterized:

| Row `name` (PK) / URL file                              | Contents                     |
| ------------------------------------------------------- | ---------------------------- |
| `static-inputs-twines.csv`, `static-inputs-miros.csv`   | StaticInputs                 |
| `static-outputs-twines.csv`, `static-outputs-miros.csv` | StaticOutputs                |
| `types-twines.csv`, `types-miros.csv`                   | types.csv                    |
| `invention.csv`                                         | invention (mode-independent) |

(Open question 3: if `miros` mode is no longer used, drop its variants and
the suffixes — 4 files instead of 7.)

## Architecture: a hybrid of two existing patterns

|        | ESF protobufs (`esf-data`)                             | Sheets API endpoints (`/api/character/*`) | **This project (`sheet-csv`)**                                      |
| ------ | ------------------------------------------------------ | ----------------------------------------- | ------------------------------------------------------------------- |
| Built  | nightly, tail step of `sde-mirror` workflow            | per-request                               | **nightly, tail step of `sde-mirror` workflow**                     |
| Source | `sde_*` mirror tables                                  | extract DB (per-user)                     | **`sde_*` mirror tables**                                           |
| Stored | `esf_data` table (base64)                              | not stored                                | **`sheet_csv` table (plain text)**                                  |
| Served | `/esf/[file]`, binary, CDN-cached, ETag on `sde_build` | CSV, `api_token`-authenticated, uncached  | **`/sheets/[file]`, CSV, CDN-cached, ETag on `sde_build`, no auth** |

The build side is a straight copy of the `esf-data` shape (`src/buildEsfData.js`

- `src/jobs/esfData.js` + the `encodeEsf` workflow step): a pure encode module
  that pages the mirror tables through the public-read anon client and returns
  `{ [fileName]: string }`, wrapped by a job that upserts into a table, kicked by
  the workflow once its input tables have landed.

The serve side is a copy of `/esf/[file]` (allowlisted filename, ETag keyed on
`sde_build`, long CDN cache with stale-while-revalidate) — but returning
`text/csv` like the Sheets API endpoints do. Unlike those endpoints there is
**no `api_token`**: the CSVs are derived purely from CCP's public SDE, contain
no player data, and are identical for every caller, so they can be public and
aggressively CDN-cached (which per-user endpoints never can be).

## Data flow

```
CCP SDE zip ──(sde-mirror workflow, 12:21 UTC nightly)──▶ sde_types, sde_blueprints
                                                              │
                              tail step (after those 2 stems drain)
                                                              ▼
                                    runSheetCsv() ──▶ sheet_csv table (7 rows)
                                                              │
                                                              ▼
        Google Sheets =IMPORTDATA("https://…/sheets/static-inputs-twines.csv")
                                                              ▲
                                              /sheets/[file] route (CDN-cached)
```

## Transform spec (ported from the Python)

Full field-by-field spec, including the script's quirks and one latent bug,
in [01-port-generator.md](01-port-generator.md). Highlights that shape the
port:

- **Blueprint dedup:** when several blueprints produce the same item, only the
  one with the **largest blueprint type id** (assumed newest) is kept.
- **`groups.yaml` is dead code** — the script loads it and never reads it. The
  port needs only `sde_types` and `sde_blueprints`, both already seeded stems
  in the mirror (`supabase/migrations/20260716010000_sde_mirror.sql`).
- **Hand-maintained constants:** the eight decryptor names force-included in
  `types.csv`, and the `Outrider Blueprint` volume override (`0.01`). These
  become named constants in the encoder module.
- **Output format:** headered RFC 4180 CSV via the existing `toCsv`
  (`src/utils/csv.ts`), matching the sample tab exports — **not** the
  Python's odd headerless `", "`-joined format (decision 1 below). Row
  _ordering_ still matches the Python so rows land in the same positions the
  sheet's adjacent formula columns expect.

## Phases

Each phase is an independently-shippable PR, smallest-first, matching the
`docs/cron-to-workflows/` playbook. **All landed** — the build side is live;
what remains is the sheet cutover (point the workbook's tabs at the URLs, see
doc 04).

1. **[01-port-generator.md](01-port-generator.md)** — ✅ `src/buildSheetCsv.js`:
   the pure transform, mirror-fed, CLI-verifiable, parity-checked against the
   Python's output on the same SDE build.
2. **[02-table-and-job.md](02-table-and-job.md)** — ✅ `sheet_csv` table
   (migration + `schema.sql`), `src/jobs/sheetCsv.js` (`runSheetCsv()`,
   `pnpm run sheet-csv`), and the unscheduled bootstrap route
   `/api/cron/sheet-csv`.
3. **[03-workflow-step.md](03-workflow-step.md)** — ✅ the `encodeSheets` tail
   step in `src/workflows/sdeMirror.ts`, gated on the `types` + `blueprints`
   stems draining.
4. **[04-serve-route.md](04-serve-route.md)** — ✅ the public `/sheets/[file]`
   route with ESF-style caching, plus docs/CLAUDE.md updates. (The sheet
   cutover checklist there is the one remaining manual step.)

## Decisions taken (revisit if wrong)

1. **Headered RFC 4180 output** (via `src/utils/csv.ts`), not byte-compatible
   with the Python: the sheet consumes tab-shaped data (`Group,Type,…` with a
   header), numbers are emitted raw (the `"6,000"` in the tab export is
   display formatting, not data), and no UTF-8 BOM (`IMPORTDATA` doesn't need
   the Python's `utf-8-sig`; the BOM was for Excel).
2. **`Group` pre-joined** into StaticInputs/StaticOutputs server-side instead
   of making the sheet look it up against types.csv — removes the `#N/A`
   failure mode seen in the current workbook.
3. **Both modes precomputed** as separate files instead of a `?mode=` param
   (cache- and allowlist-friendly).
4. **No authentication** on the serve route — SDE-derived, no player data,
   same bytes for everyone.
5. **Plain-text `data` column**, not base64 — CSV is text; base64 in
   `esf_data` exists only because protobufs are binary.
6. **`MIN_TYPE_ID` is dropped** — it's `0` in the script, so the filter never
   excludes anything (it was a dev-time knob for partial runs).

## Open questions for the repo owner

1. Route path: `/sheets/[file]` is proposed; `/csv/[file]` would work equally.
2. In the StaticOutputs sample, some rows carry Group `Input` — under the
   Python's rules a manufacturing output can't be labeled `Input`, so those
   are presumably rows whose sheet lookup hit a type the old types.csv
   labeled before it became buildable (or lookup drift). Pre-joining makes
   the label consistent; confirm the sheet's formulas don't _depend_ on the
   stale labels.
3. Is `miros` mode still used? If not, drop its file variants (7 files → 4,
   no suffixes).
4. Row-position stability: sheet columns to the right of the imported range
   reference row numbers. IMPORTDATA rewrites rows on every refresh — the
   adjacent-formula pattern survives only if ordering is deterministic (it
   is: blueprint-id order) but _inserted/removed blueprints between SDE
   builds still shift rows_, exactly as they did with manual pastes. Worth
   confirming with the sheet owner that this is understood/acceptable.
