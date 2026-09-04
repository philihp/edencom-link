# Custom ship-fitting UI (replacing `@eveshipfit/react`)

Feasibility assessment and staged plan for rendering the ship-fitting view
(wheel + statistics) with our own components and look & feel, while keeping
eveship.fit's calculation model.

**This is done.** Stages 0 through 5 have all shipped (stage 1 was folded into
0, 2 and 3); only the optional simulation work in stage 6 remains.
`/ship/[itemId]` and
`/fitting/[characterId]/[fittingId]` both draw our own viewer, `@eveshipfit/react`
and the `@eveshipfit/data` stub are gone from `package.json`, and the one piece
of eveship.fit still vendored is `@eveshipfit/dogma-engine` — the WASM
calculation model, which was always the point of keeping it. The sections below
are kept as the record of how it was done and why each choice was made.

## Verdict

Feasible, and the seam is cleaner than it looks from `shipFitView.tsx`. The
thing we actually depend on for correctness — the dogma math that turns a hull

- modules + skills into EHP/DPS/capacitor numbers — is **not** in
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
   name→id indexes). We already control both ends of this: we _encode_ those
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
  `scanStrength`, etc. are _synthetic dogma attributes_ — added by the patch
  file we already vendor (`src/esfPatches.json`) and computed inside the WASM
  engine. A custom stats panel is "resolve name→id via `attributeMapping`,
  read `calculation.hull.attributes.get(id).value`, format" — not a
  reimplementation of stacking penalties or reload math.
- **Icons are a public CDN.** Module/ship icons come straight from
  `images.evetech.net/types/{id}/icon` — no asset pipeline to replace.

Both packages are MIT, so porting the small glue pieces (flag→slot mapping,
the attribute list the stats panel reads) is clean.

## What we keep vs. what we write

| Piece                                             | Fate                                                                                                                        |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `@eveshipfit/dogma-engine` (WASM)                 | **Keep**, vendored as today; it _is_ "the same model EveShipFit comes up with"                                              |
| `esf_data` pipeline + `/esf/[file]`               | **Keep** unchanged — same 6 files, same schema, same patches                                                                |
| Protobuf decode (client side)                     | **Write** (~small): decoder against our own `src/esf.proto`                                                                 |
| Engine glue (globals + `calculate` wrapper)       | **Write** (~tiny): port of `DogmaEngineProvider` minus React context                                                        |
| ESI fit → slots (`useImportEsiFitting`)           | **Write**: port the location-flag→slot mapping                                                                              |
| Stats panel (`ShipStatistics`)                    | **Write**: our layout, reading the synthetic attributes (list ported)                                                       |
| Fitting wheel (`ShipFit`)                         | **Write**: our own SVG — the largest pure-UI item                                                                           |
| Character providers + localStorage dance          | **Delete** — we pin all-skills-V ourselves; the whole `ensureDefaultCharacter` workaround in `shipFitView.tsx` dies with it |
| `HardwareListing`/`FitManagerProvider` (simulate) | **Drop** (per scope: no module offlining, no drag-to-fit — can revisit later)                                               |
| EFT import/export, local fits, ESI login          | **Drop** — never used here                                                                                                  |
| `@eveshipfit/react` + `data-stub`                 | **Retire** at the end (also retires half of `bump-eveshipfit.yml`)                                                          |

Incidental wins: the fit becomes renderable without the placeholder
choreography (`fitPlaceholder.tsx` exists only because `EveDataProvider`
renders nothing until decode); the localStorage `currentCharacter` footgun
documented in `shipFitView.tsx` disappears; bundle shrinks; and since we have
real trained skills in `character_skill`, stats can be computed against the
_owner's actual skills_ instead of the all-V baseline — something the embed
never could. (Stage 5 did exactly that.)

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
  L1, so the all-V baseline must pass _every_ skill id explicitly (the react
  `DefaultCharactersProvider` builds this from `EveData` types with
  `categoryID` = skill). Same port, stage 0.

None of these look like showstoppers; all are cheap to prove before any UI
work starts.

## Dark launch

New route **`/item/[itemId]`** (mirroring `/ship/[itemId]`, whose data fetch —
`shipRows.ts`, `toEsiFit` in `esfFit.ts` — it reuses verbatim). Nothing links
to it, and it's additionally gated behind a `user_settings.flags` dark-launch
flag (`fit-ui`, added to `KNOWN_FLAGS` in `src/flags.ts` so Chancellors can
grant it from `/account/settings/chancellor`), same as `graphql`/`link` —
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

Shipped as `src/app/item/[itemId]/` (page + `fitDebug.tsx`, since replaced by
the viewer of stages 2–3) over
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
  row carrying its _slot's_ flag, so a launcher and its missiles both arrive as
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

#### Outcome — folded into stages 2–3, not shipped as its own step

The spike's `esf/` modules already were the typed, module-cached loader this
stage was going to extract, so moving them somewhere else would have been a
rename. What the stage was really for — a seam the UI can call and pure parts
under test — arrived with the view instead: `useFit.ts` is the one entry point
(decode → callbacks → engine → `calculate`), and the new pure modules beside it
(`ring.ts`, `panels.ts`) are covered by `pnpm test`.

Still owed, and inherited by whoever needs it: `esf/fit.ts`'s flag→slot mapping
and `esf/attributes.ts`'s formatting rules have no tests of their own, and the
decoder comparison is still the scratch harness stage 0 left behind.

### Stage 2 — statistics panel, our look & feel

Port the attribute list + derivations from `ShipStatistics` and render our own
readout (EHP + resists grid, DPS/alpha, capacitor, navigation, targeting,
drones). This is where the design work starts; the panel is pure "format
numbers", so it can iterate fast against stage 1's stable data.

**Exit criterion:** side-by-side with `/ship/[itemId]`, every number matches.

#### Outcome — done

`STAT_GROUPS` in `esf/attributes.ts` (defense, offense, capacitor, navigation,
targeting) plus a resist grid of three layers by four damage types, rendered by
`StatsPanel` in `shipView.tsx`. The flat `HEADLINE` list stage 0 compared
against is gone; the formatting rules it proved (`formatAttribute`, the
round-down/round-up asymmetry, resonance → resist) are unchanged, so the
numbers are the same ones that matched the embed.

Two figures the readout derives rather than reads: `fittingResources` computes
CPU and powergrid _used_ by subtracting the engine's `cpuFree`/`powerFree` from
the outputs, and calibration by summing `upgradeCost` off the fitted rigs —
the hull reports no remainder for that one.

### Stage 3 — slot layout, then the wheel

First a non-wheel slot rendering (grouped high/mid/low/rig/subsystem lists
with icons and charges — reusing `groupForFlag`/`flagSortKey` from
`src/app/fitting/fit.ts` so tool, page and new UI agree on slot taxonomy).
Then the centerpiece: our own SVG wheel — slot arcs sized from the hull's
slot-count attributes (already in the `Calculation`), module icons from
`images.evetech.net`, CPU/PG usage arcs from `cpuOutput`/`cpuFree` /
`powerOutput`/`powerFree`. Static display only — no drag, no state toggling,
per scope.

#### Outcome — done, as a ring of cells rather than an SVG

The ring is HTML, not SVG: `ring.ts` hands back each slot's position as a
_fraction_ of the ring's bounding square, and the cells are absolutely
positioned in percentages. One ring then scales from the 438px desktop panel to
a phone with no second code path, which an SVG with a fixed viewBox would also
have given — but this way the cells are ordinary elements carrying the module's
icon from `images.evetech.net`, with a title and a charge marker, instead of
foreignObject.

The outer three families share the circle **in proportion to their slot
counts** (fixed gaps between families come off the top first), so the arcs read
as the fit: six highs and two mids look like six highs and two mids. Rigs and
subsystems ride an inner arc, under and over the hull respectively. CPU,
powergrid and calibration are bars above the slot listing rather than arcs
around the ring — three labelled bars say "521 / 620 tf" in a way an arc
cannot.

Alongside it, and not in the original scope: the "aboard right now" bay cards
(`panels.ts` → `groupBays`), each drawn against its own capacity attribute, so
a full drone bay and a nearly empty freighter hold both read at a glance.

#### The two layouts

Both come out of one component tree. Below 900px the three panels — fit, cargo,
info — are tabs; from 900px up the tab bar disappears, every panel is simply on
the page, and the ring sits beside its slot listing. No width probing at render
time (which would have to guess before hydration): the tab state exists either
way and CSS decides whether it means anything.

Light and dark come from the palette in `globals.css` — the sheet names no
colour of its own — which is also where `--warn` was added, the amber the
resource bars needed and the two-colour `--ok`/`--danger` pair didn't have.

### Stage 4 — adoption and retirement

The original sketch here was "render the new component on `/ship` for flagged
users, soak, flip the default". The viewer has had its soak behind the `fit-ui`
flag, so the rollout is three PR-sized phases instead, each leaving the site
consistent on its own:

#### Phase 1 — export the fit from `/item` (done)

One feature the old page never had and the new one needs before it can be the
only ship page: getting the fit _out_, as the text the in-game fitting window
reads through "Import from clipboard". The identity strip's actions gain an
**Export fit** button beside Appraise, opening a native `<dialog>` with the
ship as EFT text and a button that copies it (`fitExport.tsx`). The text comes
from the same `toEft` writer the fitting pages already use
(`src/app/fitting/eft.ts`), fed by a small pure adapter from the ship's asset
rows (`eft.ts`, tested): a row with no location flag sits in no slot and no
bay, so it is dropped; a null quantity counts as one; the hull's own name is
the fit's title, its type when it has none. Type names and categories are
resolved server-side from the SDE mirror, so the dialog opens with the text
already there — no wait on the engine.

#### Phase 2 — swap the paths (done)

`/ship/[itemId]` becomes the new viewer and `/item/[itemId]` the old one, so
every existing link (the asset browser, `/asset/search`, the registrations
page, `/asset/[id]`'s ship redirect, `shareActions`' `revalidatePath`, the
`/asset/:itemId/fit` redirect in `next.config.mjs`) lands on the new page
untouched. Mechanically it was two directory moves: the new page's files went to
`src/app/ship/[itemId]/`, the old page's to `src/app/item/[itemId]/`. The
helpers both pages import — `shipRows.ts`, `shipOwner.ts`, `esfFit.ts`, the
`ShipOwner` type and portrait helpers in `shipHeading.tsx` — stayed under
`ship/`, since the new page depends on them too; the old page's relative
imports were repointed, as were the three test files' (`shipEft`,
`shipPanels`, `shipRing`). `loading.tsx` stayed where it is, since it belongs
to the route rather than to either page.

What the new page must carry before it is the canonical `/ship`, because the
old one does and links to it exist:

- **The anonymous share path.** `?share=` links (signed, recursive over the
  shared subtree) and legacy `?token=` links to `/ship/123` are in the wild.
  `SharedShipPage` — service-role client, explicitly scoped to the sharer's
  characters and corporations, location deliberately omitted — moves over
  with the viewer swapped in.
- **The Share dialog** in the actions, for a character item the caller owns
  (`fetchShareDialogData`, and `saveAssetShare`/`revokeAssetShare` bound to
  the item), so a ship can still be shared from its own page.
- **The non-ship redirect.** `/ship/<container>` sends the caller to
  `/asset/<id>` today; the new page 404s. Keep the redirect.
- **The `fit-ui` flag gate comes off** — the page is the ship page now — and
  `FIT_UI_FLAG` leaves `flagCatalog.ts` (and the Chancellor flag list with
  it). Its only job was gating this route.
- The `loading.tsx` skeleton and the `AssetPath` breadcrumb the old page
  renders; the new page already has both.

One thing the old page had that the new one deliberately did not: the
sortable `LocationAssets` module/cargo table (`shipContents.tsx`, streamed
under Suspense), whose rows drill into nested containers — a can inside a
fleet hangar. The new page's bay cards list what is aboard but link nowhere.
**Decided: the table rides along**, beneath the viewer, still streamed. It is
the only way into a container nested inside a ship, and the only place a
ship's contents can be sorted, filtered by owner, or selected for appraisal —
losing all of that to gain a shorter page was not a trade worth making.

It is no longer self-contained, though: the page already reads the child rows
for the viewer and the EFT export, so it hands them down rather than letting
the component query for them twice. What stayed behind the Suspense boundary
is what actually costs — the `*_location_contents()` subtree walk for the
nested counts, and the owner list the table's filter needs. `shipContents.tsx`
now exports two components, so the two tables can't drift: `ShipContents` for
the signed-in view and `SharedShipContents` for the share path, which has no
drill-down (a nested container would need a share token of its own), no
nested counts (the walk RPCs are skipped, so it reports none rather than a
guess) and no appraisal.

Also in this phase: `esfFit.ts` and `src/app/fitting/fit.ts` take their
`EsiFit` type from `esf/fit.ts` instead of `@eveshipfit/react` — same shape,
declared by us — so the type no longer ties the fitting pages to the package.
`flagCatalog.ts`'s label, this document, `docs/README.md` and `CLAUDE.md`'s
layout line say which page is which.

#### Phase 3 — delete the old page and its dependencies (done)

- **The fitting page moves first.** `/fitting/[characterId]/[fittingId]`
  still renders the embed (`ShipFitViewDynamic`); it switches to the new
  `ShipViewDynamic`, which takes the same `EsiFit` its `toEsiFit` already
  builds. Nothing else imports the embed after that.
- Delete `src/app/item/[itemId]/` — the old `page.tsx`, `shipFitView.tsx`,
  `shipFitViewDynamic.tsx`, `fitPlaceholder.tsx`, `shipFit.module.css` and the
  copy of `shipContents.tsx` phase 2 left there (the table itself lives under
  `ship/`). `/item/:itemId` now redirects to `/ship/:itemId` in
  `next.config.mjs` — **temporary, not permanent**, matching `/asset/:itemId/fit`
  next to it: the route was never linked, but flagged users spent the whole
  soak with it bookmarked, and a 308 would outlive any later reuse of the path.
- **Dependencies out:** `@eveshipfit/react` and its
  `vendor/eveshipfit/eveshipfit-react-4.7.2.tgz`, and the `@eveshipfit/data`
  stub (`vendor/eveshipfit/data-stub/`), which exists only to satisfy react's
  one import. `pnpm install` to rewrite the lockfile.
- **Dependencies that stay:** `@eveshipfit/dogma-engine` (the WASM engine _is_
  the calculation model; `useFit.ts` loads it directly), `protobufjs`
  (`src/buildEsfData.js` encodes the six `.pb2` files server-side; the client
  decoder in `esf/protobuf.ts` is our own), `src/esf.proto` and
  `src/esfPatches.json` (the encoder's schema and the synthetic attributes the
  readout reads), and `turbopack: {}` in `next.config.mjs` (the WASM import).
- Trim `bump-eveshipfit.yml` and `.github/scripts/bump-eveshipfit.mjs` to
  `@eveshipfit/dogma-engine` only: `PACKAGES` loses react, and the block that
  bumps the data stub to match react's peer range goes with it.
- `CLAUDE.md`'s "Vendored `@eveshipfit/*`" note shrinks to the one tarball;
  this document's "What we keep vs. what we write" table is then simply true.

The `esf/` modules keep their `@eveshipfit/react` mentions on purpose: those
are attribution for the pieces ported from it under MIT (the ESI-flag→slot
mapping, the attribute list and formatting rules, the engine's callback
contract). The dependency is gone; the credit is not.

### Stage 5 — real skills (done)

The readout now answers "what does this hull do **for me**" rather than "for a
pilot with everything at V". `character_skill` was already extracted (it drives
the job-slot bubbles), so this is plumbing plus one decision per surface about
whose skills may be quoted.

**The map is exactly the injected skills, and that is the whole contract.**
ESI's `/characters/{id}/skills/` reports the skills a pilot has injected and
nothing else, `character_skill` stores that verbatim, and eveship.fit feeds the
same engine the same thing for a logged-in character — its ESI import is
literally `for (const s of skills) map[s.skill_id] = s.active_skill_level`.
Matching it row for row is what keeps our numbers comparable with theirs. It
also sidesteps the question the all-V path had to answer: the engine treats a
skill it was **not told about** differently from one named at a level, which is
why `allSkillsAtLevel` names every skill explicitly and why the pilot map must
not invent a zero for one the pilot never injected. `toSkillLevels` therefore
drops a row whose level is null rather than reading it as 0 — `Number(null)`
being 0 is exactly the trap, and the test that says so caught the first
implementation falling into it.

**Active, not trained.** A pilot who lost skill points, or dropped to Alpha,
flies at the active level. Same column the job-slot bubbles read.

**Who may be quoted is decided by RLS, not by a rule in the page.** The query
runs on the caller's own client, so it answers only for a registration the
caller holds:

| Surface                                | Basis                                                                                                            |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `/ship/[itemId]`, own hull             | the holding character's skills                                                                                    |
| `/ship/[itemId]`, corp hull            | all-V — a corporation has no skill sheet                                                                          |
| `/ship/[itemId]`, shared in            | all-V — RLS returns no rows for someone else's registration                                                       |
| `/ship/[itemId]?share=` / `?token=`    | all-V, **deliberately**: that path holds a service-role client and *could* read the sharer's sheet. A share covers the ship, not what its owner has trained |
| `/fitting/[characterId]/[fittingId]`   | the fit's own pilot when `owner.isOwn` (RLS-proven), else all-V                                                   |
| no `esi-skills.read_skills.v1` grant   | all-V — no rows, so no claim about the pilot                                                                      |

**The toggle lives in the sentence that states the assumption.** The stats
panel's baseline line ("Calculated against …") carries a `.quiet` button that
flips between the pilot's skills and all V. The pilot's own skills are the
default where we have them — that is the point of reading them — and all-V is
one click away, since it is the basis every other fitting tool quotes and the
one a fit gets shared under. Where there is no pilot to offer, the line stays
the plain claim it always was.

Flipping recalculates through `useFit`, which keeps the previous calculation on
screen while it does: the SDE and the engine are both module-cached by then, so
the second pass is just `calculate()` and blanking back to the skeleton would
be a worse lie than a brief stale number.

Seams: `pilotSkills.ts` (`toSkillLevels` pure and tested, `fetchPilotSkills`,
`pilotSkills`), `useFit(esiFit, skills)`, `ShipView`'s `pilot` prop.

### Stage 6 (optional, later)

- Simulation (drag-to-fit / offlining) if ever wanted — the engine supports it
  (`calculate` is just a pure function of the fit), it's purely UI work.

## Effort shape

Stages 0–1 are small (the glue being ported is genuinely thin — the provider
code confirms it). Stage 2 is moderate and mostly design. Stage 3's wheel is
the single biggest chunk of work. Stage 4 is mechanical. The long pole is
visual polish, not feasibility.
