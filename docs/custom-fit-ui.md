# Custom ship-fitting UI (replacing `@eveshipfit/react`)

Feasibility assessment and staged plan for rendering the ship-fitting view
(wheel + statistics) with our own components and look & feel, while keeping
eveship.fit's calculation model. **Stage 0 is done** (see its section below);
stages 1–5 are not started.

## Verdict

Feasible, and the seam is cleaner than it looks from `shipFitView.tsx`. The
thing we actually depend on for correctness — the dogma math that turns a hull
+ modules + skills into EHP/DPS/capacitor numbers — is **not** in
`@eveshipfit/react`. It's in the separate `@eveshipfit/dogma-engine` WASM
package (Rust, MIT, vendored at `vendor/eveshipfit/eveshipfit-dogma-engine-7.1.0.tgz`),
whose entire public interface is:

```ts
export function init(): void
export function calculate(js_esf_fit: any, js_skills: any): any // → Calculation
```

`@eveshipfit/react` is three separable layers stacked on top of that:

1. **Data loading** — `EveDataProvider` fetches the 6 `.pb2` protobuf files
   and decodes them into an `EveData` object (`types`, `typeDogma`,
   `dogmaAttributes`, `dogmaEffects`, plus `attributeMapping`/`effectMapping`
   name→id indexes). We already control both ends of this: we *encode* those
   files ourselves (`src/buildEsfData.js` from the `sde_*` mirror, per our own
   copy of the schema in `src/esf.proto`, with the dogma patches in
   `src/esfPatches.json`) and serve them from `/esf/[file]`.
2. **Engine glue** — `DogmaEngineProvider` is ~20 lines: dynamically import
   the WASM module, `init()`, and install 7 globals the engine calls back
   into for data (`window.get_dogma_attributes`, `get_dogma_attribute`,
   `get_dogma_effects`, `get_dogma_effect`, `get_type`, `type_name_to_id`,
   `attribute_name_to_id`), each a one-line read of the decoded `EveData`.
   Its `calculate()` wrapper reshapes an `EsfFit` into the engine's snake_case
   input and returns the `Calculation` (per-item attribute maps with
   provenance: base value, final value, applied effects).
3. **UI + browser-state machinery** — the wheel (`ShipFit`), the readout
   (`ShipStatistics`), the drag-to-simulate browser (`HardwareListing` +
   `FitManagerProvider`), the character providers and their localStorage
   `currentCharacter` contract, ESI-fit import, EFT import/export, local fit
   storage. This is the layer we want to own, and none of it feeds back into
   the math.

Two facts make the UI rewrite tractable:

- **The derived stats are engine outputs, not UI math.** `ehp`,
  `damagePerSecondWithReload`, `alignTime`, `capacitorPeakDelta`,
  `scanStrength`, etc. are *synthetic dogma attributes* — added by the patch
  file we already vendor (`src/esfPatches.json`) and computed inside the WASM
  engine. A custom stats panel is "resolve name→id via `attributeMapping`,
  read `calculation.hull.attributes.get(id).value`, format" — not a
  reimplementation of stacking penalties or reload math.
- **Icons are a public CDN.** Module/ship icons come straight from
  `images.evetech.net/types/{id}/icon` — no asset pipeline to replace.

Both packages are MIT, so porting the small glue pieces (flag→slot mapping,
the attribute list the stats panel reads) is clean.

## What we keep vs. what we write

| Piece                                          | Fate                                                                             |
| ---------------------------------------------- | -------------------------------------------------------------------------------- |
| `@eveshipfit/dogma-engine` (WASM)              | **Keep**, vendored as today; it *is* "the same model EveShipFit comes up with"    |
| `esf_data` pipeline + `/esf/[file]`            | **Keep** unchanged — same 6 files, same schema, same patches                      |
| Protobuf decode (client side)                  | **Write** (~small): decoder against our own `src/esf.proto`                       |
| Engine glue (globals + `calculate` wrapper)    | **Write** (~tiny): port of `DogmaEngineProvider` minus React context              |
| ESI fit → slots (`useImportEsiFitting`)        | **Write**: port the location-flag→slot mapping                                    |
| Stats panel (`ShipStatistics`)                 | **Write**: our layout, reading the synthetic attributes (list ported)             |
| Fitting wheel (`ShipFit`)                      | **Write**: our own SVG — the largest pure-UI item                                 |
| Character providers + localStorage dance       | **Delete** — we pin all-skills-V ourselves; the whole `ensureDefaultCharacter` workaround in `shipFitView.tsx` dies with it |
| `HardwareListing`/`FitManagerProvider` (simulate) | **Drop** (per scope: no module offlining, no drag-to-fit — can revisit later)  |
| EFT import/export, local fits, ESI login       | **Drop** — never used here                                                        |
| `@eveshipfit/react` + `data-stub`              | **Retire** at the end (also retires half of `bump-eveshipfit.yml`)                |

Incidental wins: the fit becomes renderable without the placeholder
choreography (`fitPlaceholder.tsx` exists only because `EveDataProvider`
renders nothing until decode); the localStorage `currentCharacter` footgun
documented in `shipFitView.tsx` disappears; bundle shrinks; and since we have
real trained skills in `character_skill`, a later stage can compute stats
against the *owner's actual skills* instead of the all-V baseline — something
the current embed can't do.

## Risks / unknowns (each pinned to a stage)

- **The window-globals contract is the engine's undocumented ABI.** A future
  `dogma-engine` bump could change the callback names or `calculate()` shapes.
  Mitigation: releases are ~annual, `bump-eveshipfit.yml` opens a PR rather
  than auto-merging, and stage 0 gives us a comparison harness to catch drift.
- **Protobuf decode correctness** (varints, maps, nested messages). Proven in
  stage 0 by diffing decoded output against what the react provider produces.
- **WASM loading under Turbopack without the react wrapper.** `next.config.mjs`
  already carries `turbopack: {}` for exactly this package, and we'd use the
  same dynamic-import shape the provider does; stage 0 proves it.
- **The exact attribute list + formatting rules** the stats panel needs
  (resonances → resist %, `capacitorPeakDeltaPercentage` → stable/unstable,
  etc.). Enumerated during stage 2 by porting from `ShipStatistics` (MIT).
- **Skills input shape.** `calculate(fit, skills)` assumes untrained skills are
  L1, so the all-V baseline must pass *every* skill id explicitly (the react
  `DefaultCharactersProvider` builds this from `EveData` types with
  `categoryID` = skill). Same port, stage 0.

None of these look like showstoppers; all are cheap to prove before any UI
work starts.

## Dark launch

New route **`/item/[itemId]`** (mirroring `/ship/[itemId]`, whose data fetch —
`shipRows.ts`, `toEsiFit` in `esfFit.ts` — it reuses verbatim). Nothing links
to it, and it's additionally gated behind a `user_settings.flags` dark-launch
flag (`fit-ui`, added to `KNOWN_FLAGS` in `src/flags.ts` so Chancellors can
grant it from `/account/settings/chancellor`), same as `graphql`/`lens` —
non-flagged visitors get a 404, so obscurity isn't the only gate. Access
control is unchanged from `/ship`: same RLS-scoped fetch, same share-token
handling if we mirror it.

## Stages

Each stage is independently shippable and PR-sized; a failed proof in stage 0
ends the project at the cost of a spike.

### Stage 0 — prove the non-UI stack (spike)

Flag-gated `/item/[itemId]` that renders **no UI at all**, just evidence:

1. Client module fetches the 6 `.pb2` files from `/esf/` and decodes them with
   our own decoder against `src/esf.proto` → `EveData`-shaped object.
2. Port the engine glue: dynamic-import `@eveshipfit/dogma-engine`, `init()`,
   install the 7 data globals, build the all-skills-V skills map.
3. Port the ESI flag→slot fit conversion for the ship's rows.
4. `calculate()` and dump the raw `Calculation` (plus a handful of resolved
   headline attributes: ehp, dps, align) as JSON/`<pre>` on the page.

**Exit criterion:** for several real ships (armor/shield, turret/missile,
drones, T3 with subsystems), the dumped numbers match what `/ship/[itemId]`
shows today. That validates decoder, glue, flag mapping, and skills shape in
one shot. If this fails in a way we can't fix, we stop here having written no
UI.

#### Outcome — done, no showstoppers

Shipped as `src/app/item/[itemId]/` (page + `fitDebug.tsx`) over
`src/app/item/[itemId]/esf/`: `protobuf.ts` (schema-driven reader),
`schema.ts` (the six messages of `src/esf.proto` as data), `eveData.ts`
(fetch + decode + name→id indexes, cached per page load), `dogma.ts` (the
seven data callbacks, WASM load, all-V skills), `fit.ts` (flag → slot, ESI fit
→ engine fit) and `attributes.ts` (the readout's formatting rules and the slot
count, ported from `ShipAttribute`/`StatisticsProvider`).

Every listed risk cleared, and the proof was stronger than a page dump: the
whole stack runs headless under Node (the engine's bindings read the callbacks
off `window`, so a harness only has to alias it), which let the decoder be
diffed **entry by entry** against `@eveshipfit/react`'s own generated decoder
over the live `/esf/*.pb2`.

- **Protobuf decode:** all 89 783 entries across the six files decode
  identically to the vendored decoder (52 848 types, 26 846 typeDogma, 3 454
  dogmaEffects, 2 919 dogmaAttributes, 2 106 marketGroups, 1 610 groups), down
  to prototype-vs-own-property placement. The only differences are 321 names
  that upstream mojibakes — it builds strings byte-per-char, ours decodes UTF-8.
- **WASM under Turbopack without the react wrapper:** `next build` compiles the
  route; the existing `turbopack: {}` config was all it needed.
- **The window-globals ABI:** all seven callbacks are one-line reads, and
  `type_name_to_id`/`attribute_name_to_id` become index lookups instead of
  upstream's linear scan per call.
- **Skills shape:** 588 skill types at L5, and calculated stats land where
  they should (a 5×HML II Caracal: 18 515 ehp, 9 919 shield, 426.8 dps).

Two things came out of it that weren't in the plan:

- **The current viewer under-reports damage.** Loaded ammunition is a hangar
  row carrying its *slot's* flag, so a launcher and its missiles both arrive as
  `HiSlot0`; upstream's ESI import turns each into a module, landing two
  "modules" in one slot and leaving the weapon unarmed. A fitted, loaded Rifter
  reads **0 dps** in today's embed and 116.9 dps once the charge is routed onto
  the module sharing its slot, which `fit.ts` now does. (The claim in
  `esfFit.ts` that the hook disambiguates charges is wrong — it doesn't.)
- **Slot counts are not a hull attribute alone.** A T3's slots come entirely
  from its subsystems' `*SlotModifier` attributes, so anything reading only
  `calculation.hull` reports a Tengu with zero slots. `calculateSlots` in
  `attributes.ts` folds in the per-item modifiers, as upstream does.

Left for stage 1: the harness is a scratch script, not a checked-in test — the
decode comparison needs the multi-MB `.pb2` files, so it wants a fixture
strategy (or a small hand-built fixture) rather than a copy of the SDE in git.

### Stage 1 — extract the engine layer into a real module

Shape the spike into `src/app/item/engine/` (or `src/fitEngine/`): typed
`EveData` loader with module-level caching, `calculateFit(esiFit, skills)`,
unit-testable pure parts (flag→slot mapping, attribute resolution) covered by
`pnpm test`. No visual change; `/item` still renders the debug dump through
the new module.

### Stage 2 — statistics panel, our look & feel

Port the attribute list + derivations from `ShipStatistics` and render our own
readout (EHP + resists grid, DPS/alpha, capacitor, navigation, targeting,
drones). This is where the design work starts; the panel is pure "format
numbers", so it can iterate fast against stage 1's stable data.

**Exit criterion:** side-by-side with `/ship/[itemId]`, every number matches.

### Stage 3 — slot layout, then the wheel

First a non-wheel slot rendering (grouped high/mid/low/rig/subsystem lists
with icons and charges — reusing `groupForFlag`/`flagSortKey` from
`src/app/fitting/fit.ts` so tool, page and new UI agree on slot taxonomy).
Then the centerpiece: our own SVG wheel — slot arcs sized from the hull's
slot-count attributes (already in the `Calculation`), module icons from
`images.evetech.net`, CPU/PG usage arcs from `cpuOutput`/`cpuFree` /
`powerOutput`/`powerFree`. Static display only — no drag, no state toggling,
per scope.

### Stage 4 — adoption and retirement

- Render the new component on `/ship/[itemId]` and
  `/fitting/[characterId]/[fittingId]` for flagged users; everyone else keeps
  the eveship.fit embed.
- Soak, then flip the default and drop the flag.
- Remove `/item/[itemId]` (or keep it as a redirect), delete
  `shipFitView.tsx`/`fitPlaceholder.tsx` and the dynamic-import wrapper,
  un-vendor `eveshipfit-react-*.tgz` and `data-stub/`, trim
  `bump-eveshipfit.yml` to dogma-engine only.

### Stage 5 (optional, later)

- Real skills: feed the viewing owner's `character_skill` rows into
  `calculate()` instead of all-V, with a baseline toggle.
- Simulation (drag-to-fit / offlining) if ever wanted — the engine supports it
  (`calculate` is just a pure function of the fit), it's purely UI work.

## Effort shape

Stages 0–1 are small (the glue being ported is genuinely thin — the provider
code confirms it). Stage 2 is moderate and mostly design. Stage 3's wheel is
the single biggest chunk of work. Stage 4 is mechanical. The long pole is
visual polish, not feasibility.
