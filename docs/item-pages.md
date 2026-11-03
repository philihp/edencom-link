# Item pages: blueprints and mutated modules

Ship memory (docs/ship-memory.md) gave one kind of item a page of its own and
a text it keeps about itself. This plan extends that to the two other kinds of
item that are one of a kind: **blueprints** (an original or a copy is always a
singleton) and **mutated modules** (an Abyssal module is a unique item with a
maker ESI names). It also fixes the asset browser's link rule, which today
sends a packaged stack of hulls to a ship page.

**Status:** 🔨 in progress. PR 1 built 2026-11-02 (this doc, the link rule,
`/blueprint/[itemId]` with its job table and totals, the copy-origin
inference stored as the item's first memory). PRs 2–4 planned.

## Decisions

| Question                  | Decision                                                                                                                                                                                                                                                                                                                                             |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What gets a page          | **Assembled ships** at `/ship/[itemId]` (a packaged hull is a stack; it gets no page). **Every blueprint**, original or copy, at `/blueprint/[itemId]`. **Mutated modules** at `/asset/[itemId]` (PR 3). Containers keep `/asset/[itemId]`, and since ship-memory PR 10 (2026-11-03) so does **every other singleton** — a fitted module, a drone — where the page draws its Memory panel; `itemHref` links them.                                                                                                       |
| One route, two ids        | `/blueprint/[typeID]` already exists (the rig page). The segment becomes `/blueprint/[id]` and the page dispatches on magnitude: a type id is below `ITEM_ID_FLOOR` (10⁹; the SDE's type ids are six digits), an item id is above it (a player item's id is thirteen digits). Pure seam `src/app/blueprint/blueprintRoute.ts`, tested.                 |
| Storage                   | **`item_memory_over_time` as it stands.** It is keyed on `item_id` and takes any item, and `holds_item()` is true for a blueprint the caller holds (blueprints are asset rows). No new memory table, no new write path.                                                                                                                               |
| Who writes                | The AI over MCP, as for ships (PR 2). **One exception:** a copy's origin is a single fact the server can state, so the page writes it as the item's first memory version the first time its holder opens the page (author `origin`). The AI rewrites on top of it later.                                                                            |
| EIV "at that time"        | EIV is the ME0 bill at CCP's **adjusted** price, and the price that matters is the one in effect when the run was installed — how the game valued the job — so it must never be re-evaluated at today's prices. `market_adjusted_price` is SCD-2 (`market_adjusted_price_over_time`, migration `20261102235206`) and `market_adjusted_price_at(probes)` answers each (material, install) pair; a run older than the record takes the earliest price on record, marked approximate. The history is append-only, so freezing the fold's inputs fixes its outputs without storing them. |
| Mutated modules' maker    | `GET /dogma/dynamic/items/{type_id}/{item_id}/` is public (no scope). It names `created_by`, the source type, the mutaplasmid and the mutated attributes. A new extract reads it once per item, since a mutation never changes (PR 3).                                                                                                              |

## The link rule (PR 1)

One pure function, `itemHref` in `src/app/asset/itemHref.ts` (tested), decides
every row's link in the asset folder and in the two ship views:

| Row                                         | Link                   |
| ------------------------------------------- | ---------------------- |
| Ship category, `is_singleton`               | `/ship/[itemId]`       |
| Ship category, packaged (a stack)           | none, unless it holds items (it cannot) |
| Blueprint category                          | `/blueprint/[itemId]`  |
| Anything holding items                      | `/asset/[itemId]`      |
| A plain stack                               | none                   |

Blueprints are singletons in ESI whether original or copy (`quantity` −1 or
−2), so the category alone decides; `is_singleton` is tested anyway so a
future packaged blueprint stack, should CCP ever ship one, gets no page.

## `/blueprint/[itemId]` (PR 1)

Holder-only, on the cookie session: the blueprint row comes through
`character_blueprint_over_time` / `corp_blueprint_over_time` under RLS, the
newest version (so a sold or consumed blueprint's page still draws, marked as
no longer held). No row the caller can read is a 404, so a guessed id
confirms nothing. No share model in v1: the `/bpos` showcase is the way a
collection is shown, and a single blueprint's run history is the owner's
business.

### What the page shows

1. **Heading:** the type (icon from the `bp`/`bpc` variation), ME/TE, runs
   left for a copy, the owner, where it sits, when it was last seen.
2. **Totals** (originals and copies alike):
   - **EIV produced:** the sum over every manufacturing or reaction job this
     item ran, except cancelled and reverted ones, priced per the decision
     above.
   - **Copies made:** the copy jobs' runs summed (one run is one copy), with
     the licensed runs those copies carried in total.
   - Research and invention counts beside them, so a research BPO is not a
     page of zeros.
3. **Runs:** one row per job the item ran, newest first, from both job
   views filtered to the caller's own owners (the views also show
   co-tenants' jobs, as `/industry` notes): where (station or structure,
   named the way `/industry` names them), activity, what it made and how
   many (runs × the SDE's product quantity for manufacturing and reactions;
   copies × licensed runs for copying; `successful_runs` of the invented type
   for invention; the level for research), start, end, status, EIV.
4. **Origin**, for a copy: the job it most likely came out of (below).
5. **Memory:** the `MemoryPanel` from the ship page, with its note reworded
   ("Goes with the blueprint if you sell it").

The pure fold is `src/app/blueprint/item/history.ts` (tested): jobs plus a
pricing function in, rows and totals out. Jobs are read by `blueprint_id`,
which the job tables carry but never indexed; migration
`20261102*_industry_job_blueprint_idx` adds `(blueprint_id) where is_current`
on both tables so the read is one probe rather than a scan of the owner's
history.

### Where a copy came from

A copy's debut is the earliest version of its `item_id` across the caller's
blueprint tables. The candidate jobs are the caller's own, ended within one
extract interval before the debut (6h for a character's hangar, a day for a
corporation's, the same window as ship memory's origin rule): a **copy** job
(activity 5) whose `blueprint_type_id` is the copy's type, or an
**invention** job (activity 8) whose `product_type_id` is. One candidate is
`high` confidence; several of one kind pick the nearest at `medium` and
report the count; none, and the copy's past is unknown. A debut at the
owner's first blueprint extract predates the record, and the page says so
instead of guessing. Pure seam `src/app/blueprint/item/origin.ts`, tested.

**Stored lazily.** When the page is opened by the holder, the item has no
memory yet, and the inference found a job, the page writes one version
through `item_memory_write()` on the cookie session (RLS decides, as for
every memory write), author `origin`, body a plain first-person sentence
naming the job, the place and the date, with the confidence where it is not
`high`. A second view reads it back instead of inferring again. The write is
best-effort: a refusal (the viewer is an author reading a sold copy, say)
leaves the page showing the inference it computed.

## MCP: the AI writes a blueprint's memory (PR 2)

- `recall_blueprint(blueprint)` answers the same dossier the page draws
  (runs, totals, copies, origin), the current memory with its `version_id`,
  and the voice: a blueprint has no faction, so the accent is the **product's**
  faction or race through `accent.ts`, and the register is a new chart keyed
  on the product's category (a ship blueprint speaks like a shipwright, a
  module blueprint like a toolmaker, a reaction formula like a chemist).
  The "fuzzy memory" the owner asked for is this dossier written up in that
  voice: an original remembers its runs the way a long-serving foreman does,
  by the shape of them rather than every number.
- `remember_ship` is widened to `remember_item(item, …)` with `remember_ship`
  kept as an alias, since the storage and the write function never cared
  what the item was. The skill doc gains "Writing a blueprint's memory".

## Mutated modules (PR 3)

### The extract

`item-dynamic` (`src/jobs/itemDynamic.js`): for every current asset row
whose type's `metaGroupID` is 15 (Abyssal) and whose `item_id` has no
`item_dynamic` row, call `dogma/dynamic/items/{type_id}/{item_id}` (public;
`esiJsonTolerant`, a 404 stamped so it is never asked again) and store
`item_dynamic (item_id pk, type_id, source_type_id, mutator_type_id,
created_by bigint, dogma_attributes jsonb, dogma_effects jsonb, fetched_at)`.
Owner-or-share read through `holds_item()` and the asset share predicate;
service-role write. A mutation never changes, so one fetch per item for
ever. Daily, after the asset extracts; a budget of 500 items a run.

### The personality

Pure seam `src/app/asset/item/personality.ts` (tested): the mutated value of
each attribute against the source type's base from `sde_type_dogma`, judged
by the attribute's `highIsGood` from `sde_dogma_attributes`, into traits:

| Attribute moved             | Trait                        |
| --------------------------- | ---------------------------- |
| CPU need (50) down          | smart                        |
| CPU need (50) up            | dumb                         |
| Power need (30) up          | brutish                      |
| Power need (30) down        | meek                         |
| Every other attribute, net good | cocky, arrogant          |
| Every other attribute, net bad  | inept, clumsy            |

"Net" weighs each other attribute's relative change by its sign under
`highIsGood`, so a module that rolled a better bonus and a worse duration is
judged on the balance. The traits are facts for the AI; the page shows the
roll (each attribute, base → mutated, better or worse) and the maker's name
(`created_by` through `character_directory` / `universe_name`), and
`recall_module` hands the traits, the maker and the roll to the AI, which
writes the module's split personality on top of them — a Frankenstein of the
source module and the mutaplasmid, with the voice the traits give it.

### The page

`/asset/[itemId]` already answers a container. A mutated module has no
contents, so the page gains a branch for an item with an `item_dynamic` row:
the roll table, the maker, and the Memory panel.

## Adjusted-price history (PR 4, folded into PR 1)

`market_adjusted_price` is the SCD-2 pair every versioned table here uses:
`market_adjusted_price_over_time` (one open row per type, `(type_id,
valid_from)` btree for the per-moment probe) behind a like-named view of the
current rows that keeps the old columns, `recorded_at` being the open
version's `valid_until`, so every other reader (`/structure`'s EIV, the
rollup, `/sheets/adjusted-prices`, the hull-price page) is unchanged. The
daily job reconciles like `market-prices` does over the pure seam
`src/jobs/adjustedPriceReconcile.js` (tested): touch, close-and-reopen,
close on vanishing; it refuses a listing under `MIN_PLAUSIBLE_TYPES`, since
a short answer is a truncated response, not a mass delisting. Both prices
are rounded to ISK precision before comparison. Adjusted prices move a
little for most types every day, so expect ~15k rows a day.

`market_adjusted_price_at(probes)` is `market_price_at()`'s shape without
the market: the version in effect at each moment, or the earliest on record
flagged `exact: false` for a moment before the capture began (2026-08-26;
the migration seeds each type's first version at its last sighting). The
blueprint loader probes every material at every priceable run's `start_date`
and the fold's `priceAt` answers a `PricePoint { price, exact }`; a run is
exact only when every material was, the row shows `≈` otherwise, and the
totals strip counts `approximateRuns`. `test/sql/market_adjusted_price_at.sql`
runs the migration itself against the old table's shape.

## PRs

1. **Links, the page, the copy origin.** This doc; `itemHref.ts`;
   `/blueprint/[id]` dispatching between the rig page and the item page;
   `history.ts`, `origin.ts` (both tested); the blueprint-id index
   migration; the `MemoryPanel` note. Built 2026-11-02.
2. **MCP.** `recall_blueprint`, `remember_item`, the product-category
   register, the skill section. **Shipped as ship-memory PR 7**
   (docs/ship-memory.md "Extension: every singleton", 2026-11-02): one
   generic `recall_item`/`remember_item` over every kind, with the blueprint
   dossier (research steps, build/copy/invention tallies) and the clerk
   voice whose register is the blueprint's research; the product-category
   register idea was not taken.
3. **Mutated modules.** The `item-dynamic` extract and table, the
   personality seam, the `/asset/[itemId]` branch, `recall_module`.
4. **Adjusted-price history.** The SCD-2 table and the per-moment pricing.
   Folded into PR 1 on 2026-11-02: the price at the install is what a run
   meant, so the page never shipped at today's prices.

## Open questions

- **Sharing a blueprint.** The page is holder-only. A share row on the
  Revision 3 shape (`blueprint_share`, per item) would let a seller show a
  BPO's run history to a buyer, and the memory would follow the share as a
  ship's does. Not planned until someone asks.
- **A consumed copy.** A BPC's last run consumes it, so its page outlives it
  by design. Should its memory close with a last line ("spent on …")? The
  job that consumed it is in its own run table, so the page can say it
  without a write.
