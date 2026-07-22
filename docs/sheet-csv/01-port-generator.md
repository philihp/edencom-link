# PR 1: port the generator to `src/buildSheetCsv.js`

## Goal

A pure encode module, shaped exactly like `src/buildEsfData.js`: reads its SDE
inputs from the nightly-mirrored `sde_*` tables through the public-read anon
client (needs `NEXT_PUBLIC_SUPABASE_URL`/`_ANON_KEY`, no service role), applies
the transform, and returns `{ [fileName]: string }` without touching disk or
the writable DB. No table, no route, no workflow change yet — those are PRs
2–4.

```js
export const SHEET_FILE_NAMES = [
  'static-inputs-twines.csv',
  'static-inputs-miros.csv',
  'static-outputs-twines.csv',
  'static-outputs-miros.csv',
  'invention.csv',
  'types-twines.csv',
  'types-miros.csv',
]
export const encodeSheetCsv = async () => ({ /* name → csv string */ })
```

## Inputs

Only two mirror tables (the Python also loads `groups.yaml`, but never reads
it — dead code, dropped in the port):

- `sde_types` — per type: `name.en`, `groupID`, `metaGroupID`, `volume`
- `sde_blueprints` — per blueprint: `activities.manufacturing`,
  `activities.reaction`, `activities.invention`, each with `materials`,
  `products`, `time`

Both are already seeded stems in the mirror
(`supabase/migrations/20260716010000_sde_mirror.sql` seeds `types` and
`blueprints`), so **no migration is needed** for this PR. Page them 1000 rows
at a time exactly like `buildEsfData.js`'s `readMirror(stem)` — lift that
helper or copy it. Each row's `data` jsonb is the raw SDE JSONL object; the
`_key` is the type/blueprint id. Verify the field casing against live rows
before coding (the JSONL uses `typeID`, `metaGroupID`, etc. — same as the
YAML), and confirm whether `_key` arrives as number or string.

Memory note: `sde_types` is ~50k rows and `sde_blueprints` ~5k — far smaller
than the `type_dogma` table the ESF encode already pages inside one workflow
step, so a single-invocation build is comfortably in budget.

## Transform spec

The row *data* below is a faithful port of the Python; the *serialization*
diverges deliberately (headered RFC 4180 instead of the Python's headerless
quoted format — see README decision 1), and the `Group` column is a new
pre-join the Python left to sheet-side lookups.

### Step 0 — name maps

From `sde_types`: `idToName` (id → `name.en`) and `nameToId`, skipping types
without an English name. Missing names later fall back to `Type <id>`.

### Step 1 — blueprint dedup

When multiple blueprints produce the same output item, keep only the blueprint
with the **largest blueprint type id** (assumed most recent). "Output" means:
first product of `manufacturing` if present, else first product of `reaction`,
else the blueprint has no output and is kept unconditionally (it may still
carry an invention activity).

### Step 2 — industry rows (StaticInputs, StaticOutputs)

For each surviving blueprint (ascending blueprint-id order, preserving the
dedup's re-pointing — see "Row ordering" below), for each of its
`manufacturing` and `reaction` activities: only when the activity has
**exactly one product** and a `materials` list —

- **StaticInputs**, one row per material:
  `Group,Type,Material,InputQty` =
  `<group label of output>, <output name>, <material name>, <material quantity>`
- **StaticOutputs**, one row:
  `Group,Type,OutputQty,JobTime` =
  `<group label of output>, <output name>, <output quantity>, <activity time in seconds>`

`JobTime`/quantities are raw numbers — no thousands separators (the `"6,000"`
in the sample tab export is Google Sheets display formatting).

Track three id sets along the way: every id seen (`types`), reaction outputs
(`reactionTypes`), manufacturing outputs (`industryTypes`). These drive the
group labels (step 4), which means labeling is a **second pass**: `Group` for
a given output isn't knowable until all blueprints have been scanned
(membership in `reactionTypes`/`industryTypes` decides `Reaction`/`Input`).
Collect the row tuples first, resolve labels after, serialize last. The label
differs per mode only in the `Component` branch, so one collected row set
serializes into both `-twines` and `-miros` variants.

> Python quirk, do **not** port: `insert_industry_lines` builds per-call dicts
> keyed by output id (a half-finished dedup, per its own TODO) and its final
> loop appends `id_to_output_line[output_id]` while iterating `type_id` — a
> latent bug that's harmless only because the dict never holds more than one
> entry per call. The port should just append rows directly.

### Step 3 — invention rows (`invention.csv`)

For each surviving blueprint with an `invention` activity having **exactly two
materials** (the two datacores), one row per product:

`<product name>, <blueprint name>, <base runs = product quantity>,
<datacore1 name>, <qty>, <datacore2 name>, <qty>,
<activity time>, <probability>`

Header: `Type,Blueprint,BaseRuns,Datacore1,Datacore1Qty,Datacore2,Datacore2Qty,JobTime,Probability`.

`probability` defaults to `1.0` when absent. Add both datacores, the blueprint
id, and every product id to `types`. Note the Python indexes `id_to_name[...]`
directly here (a KeyError if a datacore/blueprint name were missing) — the
port should use the same `Type <id>` fallback as step 2 rather than throwing.

### Step 4 — group labels and `types.csv` (both mode variants)

Seed `types` with the eight decryptors, resolved by name (a hand-maintained
constant; if CCP renames one, resolution fails — log and skip rather than
throw):

> Accelerant / Attainment / Augmentation / Parity / Process / Symmetry /
> Optimized Attainment / Optimized Augmentation Decryptor

**Group label for a type id** (shared by types.csv and the step-2 pre-join):

- in `reactionTypes` → `Reaction` (checked first, wins over everything)
- **miros mode only:** `groupID` ∈ {334, 873, 913} → `Component`
- else by `metaGroupID`: 1 → `Tech I`, 2 → `Tech II`, 3 → `Tech III`;
  absent → `Input` if the id is not in `industryTypes`, else `Tech I`;
  any other value (4, 5, 14, …) → `Tech I` (the Python's fall-through
  default — faction/officer/abyssal items label as Tech I; preserve it)

**types.csv rows:** for every id in `types` (ascending) that exists in
`sde_types`: `TypeID,Group,Type,Volume`. `Volume` is `''` when absent; hard
override: `Outrider Blueprint` → `0.01`. (`MIN_TYPE_ID` is 0 in the script —
the filter is a no-op, dropped.)

### Serialization

RFC 4180, header from object keys, CRLF — build each file as an array of flat
objects whose key order is the column order above. No BOM (Sheets `IMPORTDATA`
doesn't need the Python's `utf-8-sig`; that was for Excel). The serializer is
**inlined** in `buildSheetCsv.js` (a copy of `src/utils/csv.ts`'s `toCsv`
logic) rather than imported: these job modules run under plain `node`, which
can't import a `.ts` file. `@supabase/supabase-js` is likewise imported lazily
inside the DB path so the pure `buildSheets` transform has no runtime
dependency and stays unit-testable without a database.

### Row ordering

Deterministic and Python-matching, so regenerations diff cleanly and rows
land where the sheet's adjacent formula columns expect:
StaticInputs/StaticOutputs/invention follow the dedup result's iteration
order (sorted blueprint ids, with a duplicate-output blueprint's slot moved
to the end of the no-output group, exactly as the Python's dict-update does
— replicate whatever the parity check shows); `types-*` sorted by type id
ascending.

## Style

House rules apply: ramda over `for`/`while` (`src/jobs/*.js` is the model),
mutable `.push()` accumulators inside a `reduce` are fine for the big row
arrays, async pagination recurses or uses `forEachSequential`. Plain `.js` +
JSDoc like `buildEsfData.js`, not TS.

## Verification (parity check)

Because the serialization deliberately diverges, parity is checked on the
**data**, not the bytes:

1. Identify the SDE build currently mirrored (`sde_mirror_state`).
2. Run the Python against the matching YAML export (`--mode twines`, then
   `--mode miros`) — it's kept in
   [`reference/full_sheet_gen.py`](reference/full_sheet_gen.py).
3. Run the port (`node` one-liner calling `encodeSheetCsv()`, writing the
   seven strings to files).
4. Normalize both sides (strip BOM/headers/quoting, parse into field tuples;
   drop the port's `Group` column from StaticInputs/StaticOutputs to compare
   against `inputs.csv`/`outputs.csv`) and diff:
   - StaticInputs ↔ `inputs.csv`, StaticOutputs ↔ `outputs.csv`,
     `invention.csv` ↔ `invention.csv`: identical tuples in identical order.
   - `types-twines.csv` ↔ twines `types.csv`, `types-miros.csv` ↔ miros
     `types.csv`: identical.
   - The pre-joined `Group` column must equal the label the corresponding
     mode's `types.csv` gives that output's type id, for every row.
5. Spot-check against the real workbook tab exports: same leading columns,
   same row order for a sampled region (ignoring the workbook's `#N/A`
   lookup failures and number formatting).

No lint errors (`pnpm run lint`); no `package.json` script yet (PR 2 adds the
job CLI).
