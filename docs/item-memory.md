# Item memory

Every singleton item we track can carry a memory, written in its own voice,
by the one mechanism `docs/ship-memory.md` built for hulls. A Vexor Blueprint
Original answers how many hulls it has built the way a Phoenix Navy Issue
answers where it has docked. This document is the plan for widening the ship
work to every singleton; the ship document stays the ship chapter, and
nothing in it is undone.

**Status:** 📝 plan, written 2026-11-02 against the data as it stood that day.
Nothing here is built. The storage needs no change (see What the data already
does); the work is in the tools, the dossiers, the voices and the pages.

## Decisions (owner, 2026-11-02)

- **Singletons carry memory; stacks do not.** A stack is fungible by the
  game's own rules — five packaged Rifters are one row and no one of them is
  anyone — so there is nothing for a memory to attach to, and merging into a
  stack is the one event that ends an item id. A singleton (`is_singleton`
  true: an assembled ship, a researched blueprint, a fitted module, a
  container, a drone in a bay) keeps its id through research, trades,
  contracts, hangar moves and assembly (measured, below), so its memory
  follows it.
- **One mechanism for every item.** `recall_item` and `remember_item`, with
  the dossier chosen by the item's SDE category. `recall_ship` and
  `remember_ship` stay as aliases of the same handlers so every client and
  the skill doc keep working.
- **Nothing is written until someone asks.** No job seeds memories. The first
  `recall` of an item assembles its formative dossier from the history on its
  id — the research steps a blueprint has had, the hulls a module has been
  bolted to, the docks a ship has made — and the companion writes the first
  version from that. The acquired accents below are therefore **computed at
  recall from the history, never accrued in a table**: there is no growth
  state to maintain, and an item asked about for the first time after two
  years sounds exactly as it would have if asked every day.
- **Modules are droids.** A module's native voice is a robotic one with a
  limited vocabulary. A **high-slot module** (weapons, miners, remote
  repairers, anything in `HiSlot0`–`HiSlot7`) starts as a brutish thug, and
  takes on the accents of the ships it spends time attached to: linearly,
  reaching 100% of a hull's accent after one year attached to that hull, and
  carrying several hulls' accents at once when its history has several.
- **Ships pick up a little lingo from highsec.** Each highsec region belongs
  to an empire in the SDE (`factionID` on the region), and a ship that dwells
  there picks up a tiny bit of that empire's turn of phrase — never a change
  of accent, a seasoning on top of the hull's own voice.

## What the data already does

The ship work was built per item id rather than per ship, so the storage,
authorization and reassembly already serve every singleton. Confirmed by
reading `schema.sql` and the job modules on 2026-11-02:

- `item_memory_over_time` keys on `item_id` with `type_id` recorded at write
  time; nothing near it names a category.
- `holds_item()` reads both hangar tables for any current row the caller's
  registration or corporation holds. The RLS policies, `item_memory_write()`
  and `item_memory_carry()` call it or check the type and nothing else.
- The reassembly fold (`src/jobs/reassembly.js`) watches every memory-bearing
  item that vanishes while a stack of its type grows, and the singleton flip
  that is an assembly, for any category. For a researched blueprint it never
  fires, because a researched blueprint cannot enter a stack; for a module it
  works as it does for a hull.

**Every ship-only gate is app-side**, and there are four:

| Where                                            | What it does                                                                     |
| ------------------------------------------------ | -------------------------------------------------------------------------------- |
| `src/app/api/mcp/memoryTools.ts` name resolver   | Matches a name only over ship-category rows                                      |
| `memoryTools.ts` `recall_ship`                   | Refuses a held item whose category is not Ship                                   |
| `memoryTools.ts` `remember_ship`                 | The same refusal before the write                                                |
| `src/app/ship/[itemId]/page.tsx`                 | The only page that draws the Memory panel; a container or blueprint has no page |

No migration is needed for the storage. One view change is needed for the
regional lingo (see The voice).

## What "every singleton" is

Current singleton rows across both hangars, by SDE category, 2026-11-02:

| Category                                        | Singletons | Notes                                                            |
| ----------------------------------------------- | ---------: | ---------------------------------------------------------------- |
| Blueprint                                       |    137,347 | Originals and copies; 6,873 originals seen as `quantity -1`      |
| Module                                          |     75,952 | Fitted modules are singletons; 15,437 in high slots on 4,180 hulls |
| Ship                                            |      7,898 | The chapter already written                                      |
| Drone                                           |      6,377 | 5,059 of them in drone bays                                      |
| Charge                                          |      4,453 | Loaded ammunition and scripts; consumed, so of little interest   |
| Celestial                                       |      3,087 | Cargo containers and secure containers (CCP's category for them) |
| Subsystem, Structure Module, Deployable, Fighter, Structure, Starbase | under 1,200 together |                                                 |

Blueprints outnumber ships seventeen to one and modules ten to one, which is
why the lazy rule matters: the dossier is built when asked, not for 137,000
blueprints nightly.

## What each kind of item knows

The ship dossier (`src/app/ship/memory/dossier.ts`) stays as it is. Each
other category gets a fold of its own in `src/app/ship/memory/` (the folder
keeps its name; it is where the memory code lives), and a **generic** fold
covers anything without one. Every fold answers the same envelope: the facts,
the voice, the current memory with its version id, `before_you`, the readers,
`inherit_candidates`, and the `how` paragraph. A `kind` field names which
dossier answered.

### Blueprint

Every industry job carries `blueprint_id`, the blueprint's **item id**, so a
blueprint's working life is recorded against its id directly, with no
inference at the join. Confirmed 2026-11-02: of 394 TE, 416 ME and 503 copy
jobs in the character job history, 388, 410 and 426 name a blueprint item we
hold (the rest sit in corp hangars or were copies consumed before an extract
saw them). The question that motivated this plan, asked of production:

| Vexor Blueprint (item id) | ME / TE | Manufacturing jobs | Hulls built | Research jobs |
| ------------------------- | ------- | -----------------: | ----------: | ------------: |
| 1011382969076             | 10 / 20 |                 10 |         547 |             0 |
| 1044842254750             | 10 / 20 |                  4 |         284 |             0 |
| 1001192477360             | 10 / 20 |                  9 |         273 |             0 |
| 1037785175674             | 10 / 20 |                  5 |         234 |             0 |
| 1055121563754             | 8 / 16  |                  0 |           0 |             3 |

The fold reads, all on `item_id`:

- **Research**: every ME/TE version of the blueprint row, and the research
  jobs (activities 3 and 4) with installer, facility, dates and `cost`. The
  blueprint's research history and its job history are two views of the same
  steps; where both exist the job gives the when and where, the version the
  before and after.
- **Building**: manufacturing jobs (activity 1) with `runs`, the product and
  its quantity per run, the facility and the install cost. "How many Vexors"
  is the sum of runs over delivered jobs, and the dossier says **at least**,
  since the record starts when the job extract first ran for that owner.
- **Copying**: copy jobs (activity 5) with `runs` and `licensed_runs`. A copy
  job's output copies get new ids the job row does not name; their provenance
  is inferred the way the ship matcher infers assembly — copies of the type
  debuting at the job's `output_location_id` around its end date — and is
  reported with a confidence, as the ship origin is.
- **Where it has lived**: hangar moves (a researched original moving to the
  corp hangar keeps its id: 1,299 of 1,302 that left a character hangar
  reappeared in `corp_blueprint_over_time`), contracts naming it, and the
  stations and structures of the jobs.
- **Whether it is still held**, as for a ship.

Identity facts, measured 2026-11-02 over 51,582 blueprint ids: research
changed ME or TE on the **same id** 257 times across 202 ids; 207 ids went
from a stack to a singleton (a pristine original pulled out of a stack keeps
the stack's id, as a hull does); **none** went from singleton back to stack.
A researched blueprint is a singleton for life. Reaction formulas cannot be
researched, stack freely, and so have no identity to lose: they are the
fungible case, and the owner's instinct about them is right.

### Module

A fitted module is a child of its hull: `location_id` is the hull's item id
and `location_flag` the slot. Its history is therefore a list of
**attachments** — hull, slot, from, until — straight from its version rows,
plus the places those hulls were at (through the hull's own location rows)
and the pilots who flew them (through `character_ship_over_time`, as the ship
dossier does). The fold answers:

- Attachments, hull by hull, with days attached and the slot. Measured
  2026-11-02: of 15,437 high-slot modules fitted now, the median has been on
  its current hull 43 days, 58 have been on more than one hull in the record,
  and one has been on seven.
- The hulls' accents, weighted by time attached (see The voice).
- Debut and origin (built, bought, contracted) by the ship fold's inference,
  which is type-agnostic.
- Whether it is fitted now, in a hangar, or packaged (a packaged module is a
  stack of one and carries its memory until it merges, exactly as the ship
  chapter says of a packaged hull).

### Container

CCP files cargo and secure containers under category Celestial. A container's
dossier is its places and what it has held: every item whose `location_id`
was the container, as spans, with at-least quantities — the ship dossier's
cargo fold applied to a different parent. Containers are named in ESI, so
they resolve by name like hulls.

### Everything else

Drones, charges, subsystems, deployables, structure modules and anything the
plan has no fold for take the **generic** dossier: names if ESI names it,
debut and origin, the places it has been and the owners it has had, whether
it is held now. A drone in a bay is a child of its hull like a module, so the
generic fold reports the parents it has sat in; a module-specific attachment
fold is not needed for the voice to work there, since drones keep the droid
voice without acquiring accents.

## The voice, generalised

The ship chapter's voice has two parts: an **accent** from the hull's faction
and race (`accent.ts`, keyed on SDE ids) and a **register** from its hull
class (`register.ts`). Both stay. Two things are added.

### A native voice per category

| Category              | Native voice                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ship                  | As the ship chapter: accent by faction and race, register by hull class.                                                                               |
| Module (not high-slot) | A robotic droid with a limited vocabulary. Short declaratives, status words, numbers. No accent of its own; the accent column reads "droid".           |
| Module (high-slot)    | The same droid, but a brutish thug: blunt, proud of damage dealt or ore pulled, impatient with idle time. Acquires the accents of its hulls (below).   |
| Blueprint             | **Owner's call.** A draft to edit: a patient clerk who counts in runs and remembers every pilot who ever put it in a slot. Its register is its research: ME 0 is a novice, ME 10 / TE 20 has seen everything. |
| Container             | **Owner's call.** Draft: a warehouse foreman; talks about what passed through.                                                                        |
| Everything else       | The droid, without the thug.                                                                                                                            |

The chart is a table in this doc pinned by a test, as the ship accent chart
is; the pure module is `src/app/ship/memory/nativeVoice.ts`.

### Acquired accents

A pure fold, `src/app/ship/memory/accentBlend.ts` (tested), takes the item's
history and answers a list of accents with weights in `[0, 1]`, which the
tool reports as `acquired_accents` beside the native voice, and the `how`
paragraph tells the companion to blend them: at 0 the item speaks only its
native voice; at 1 it speaks that hull's accent as fully as the hull does.

**High-slot modules.** For each hull the module has been fitted to, the days
attached are summed over every attachment to that hull (a module that came
off and went back on the same hull keeps counting), and the weight is
`min(1, days / 365)` of that hull's `voiceOf` accent. Several hulls give
several accents, each with its own weight; two hulls of one faction add
their days before the cap. The list is sorted by weight. Only time in a
`HiSlot*` flag counts — a thug in a cargo hold is not learning anything. The
fold reads the module's version rows and the hulls' types; nothing is stored.

**Ships in highsec.** For each highsec region (system `securityStatus` ≥ 0.45)
a ship has dwelt in, the days are summed over its location rows (station →
system through `sde_station`, structure → system through
`universe_structure`, as `/structure` resolves them), and the region's
`factionID` names the empire. Measured 2026-11-02: hulls in the character
hangar have 160,510 dwell-days in highsec across 24 regions, every one of
which carries a faction in the SDE (Amarr 8 regions, Gallente 6, Caldari 5,
Minmatar 3, Ammatar, Khanid and CONCORD one each). The weight is **small by
design**: `min(LINGO_CAP, days / 365 × LINGO_CAP)` per region's faction,
with `LINGO_CAP` an owner's constant drafted at 0.1, and the tool reports it
as `lingo` rather than `acquired_accents`, so the companion reads it as a few
borrowed phrases and never a second voice. Lowsec and nullsec regions carry
factions in the SDE too (Curse is Angel, Venal is Guristas, Stain is
Sansha's); the owner decided highsec only, and the fold takes the band as a
parameter so that can change in one place.

The region's faction needs one read the app does not have today: the
`sde_region` view exposes `region_id` and `name` only. PR 3 adds
`faction_id` to the view (a `schema.sql` change plus a migration, since the
mirror job defines no views) and a `getSdeRegionFactions` reader in
`src/sdeRegions.ts`.

**Why computed, not accrued.** The owner's rule that nothing is written until
asked means a module might be asked about for the first time after a year on
three hulls. Reading its version rows and summing days gives the right
weights that day; a nightly accrual would have had to run for a year first.
The fold is a few hundred rows per item at most, read on the bearer client
inside the one recall, and the version rows are already what the module
dossier reads.

## Resolving an item

`recall_ship` takes an item id or an in-game name over the caller's hulls.
Modules and blueprints have no ESI name, so `recall_item` widens the resolver:

- A run of five or more digits is an item id, as now.
- Otherwise the text is matched as a **name** over the caller's named
  singletons (ships and containers), then as a **type name** over the
  caller's singletons of that type ("my Vexor BPO", "the Vexor Blueprint"):
  one held item of the type resolves; several are listed with their id, their
  place and, for a blueprint, ME/TE and hulls built, so the user can pick.
  The `match.ts` rule applies — ambiguity is refused with the list, never
  guessed.

## Display

- The Memory panel is drawn by `/asset/[locationId]` for a container, read
  the way the ship page reads it (holder's session, else service role once a
  share proved reachable).
- Blueprints and modules have no page. `/item/:itemId` is today a redirect to
  `/ship/:itemId`; PR 4 makes `/item/[itemId]` the generic item page — the
  item's identity strip, its dossier facts and the Memory panel — and keeps
  redirecting ships to `/ship`. A share link to one unfurls through the
  generic `summaryCard`, per the "every share link unfurls" rule.
- `/bpos/[name]` could link each original to its item page; not in this plan.

## MCP tools

- **`recall_item(item)`**: `recall_ship` with the category gate removed and
  the dossier chosen by category. Same envelope, plus `kind`
  (`ship` / `blueprint` / `module` / `container` / `item`), `native_voice`,
  `acquired_accents` (modules) and `lingo` (ships). `recall_ship` is an alias
  that additionally refuses a non-ship, so a client that only knows ships
  gets the old answer.
- **`remember_item(item, memory, based_on, author?, inherit_from?)`**: the
  same write path for every singleton; `remember_ship` the alias. The ship
  tools' annotations carry over unchanged.
- The skill doc's "A ship's memory" section becomes "An item's memory", with
  the writing procedure unchanged and a paragraph per native voice.

## Reassembly for other categories

The fold already runs for every memory-bearing singleton. A module that is
unfitted and repackaged becomes a stack of one under a new id — the pack event
— and is assembled back into a module under that stack's id — the flip. The
pack table's `type_id` and the carry's type check hold for any category.
Blueprints never reach it. Nothing to build.

## PRs

1. **Generic tools and the blueprint dossier.** `recall_item` /
   `remember_item` with the ship tools as aliases, the widened resolver
   (name, then type name), the generic dossier, and the blueprint fold over
   the job and blueprint histories (pure, tested; the Vexor table above is
   its acceptance test). Skill doc section renamed. This alone answers the
   owner's question.
2. **Module dossier and the droid voices.** The attachment fold,
   `nativeVoice.ts` with the chart above, `accentBlend.ts` for high-slot
   modules (tested against hand-built histories: one hull for 100 days is
   0.27, two hulls, a year on each, are two accents at 1.0). The container
   fold rides along, being the cargo fold with a different parent.
3. **Lingo.** `sde_region.faction_id` (view + migration), the region reader,
   the dwell fold, `LINGO_CAP`.
4. **Pages.** `/item/[itemId]` and its card; the panel on `/asset/[id]` for
   containers.
5. **Docs.** `docs/ship-memory.md` becomes the ship chapter of this document,
   with the generic rules stated once here.

## Open questions

- **The blueprint and container native voices** are drafts for the owner, as
  the ship accent chart was.
- **`LINGO_CAP`** at 0.1, and whether lowsec and nullsec factions should ever
  season a hull. The fold takes the band as a parameter either way.
- **Charges.** Loaded ammunition is a singleton while loaded and consumed
  soon after. The generic dossier would answer for one, but the plan does not
  go out of its way for them.
- **Battles.** Nothing in the data records combat, which is why the writing
  procedure forbids inventing one. A `character-killmails` extract
  (`esi-killmails.read_killmails.v1`; each killmail names the ship item id the
  victim flew and the attackers' ship types) would give hulls their fights
  and high-slot modules their kills. A plan of its own.
