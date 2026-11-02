# Ship memory

A text a ship keeps about itself. Any item a player holds can carry one
markdown document. The first chapters here are about ships; the extension
at the end widens the same mechanism to every singleton we track. The player's AI companion
(Aura, Claude, ChatGPT, over MCP) writes it in the ship's own voice: where it
came from, where it has docked, what it has hauled, how it keeps its fuel, who
has flown it. The AI rewrites it as the ship's history grows, so the memory
accumulates, and every version is kept.

**Status:** 🔨 in progress. PR 1 (one holder per item id) was built on
2026-11-01: migration `20261101065555_asset_claim_cross_hangar` and
`test/sql/asset_claim_cross_hangar.sql`. Its production measurement found
only handoffs waiting on a pull, so it is safe to merge (see One holder per
item id). PR 2 (storage and accent) was built the same day: migrations
`20261101090426_item_memory` and `20261101090428_sde_type_faction`,
`test/sql/item_memory.sql`, and `src/app/ship/memory/accent.ts` with
`test/shipMemoryAccent.test.ts`. It differs from this plan in two places,
both noted where they land: the table gains `closed_by` (see Storage), and the
accent is keyed on the SDE's ids rather than its names (see Accent). PR 3 (the
dossier and `recall_ship`) was built the same day: `src/app/ship/memory/dossier.ts`
(the pure fold, `test/shipMemoryDossier.test.ts`), `register.ts` (the hull-class
register, pinned against the chart below like the accent), `load.ts` (the one
loader, both hangars), `src/sdeDogma.ts` (the fuel-bay capacity, dogma
attribute 1549), `src/app/api/mcp/memoryTools.ts` with its pure seam
`memoryQuery.ts` (tested), and a first "A ship's memory" section in the skill
doc, since `get_skill` must name every tool. Where it differs from the plan is
noted where it lands (see Where it came from, and the MCP tools). PR 4
(`remember_ship` and the skill section) was built the same day, in
`memoryTools.ts` beside the read tool, with the write seam in
`memoryQuery.ts` (tested) and "Writing a ship's memory" in
`docs/edencom-industry-SKILL.md`. PR 6
(reassembly) was built the same day, beside PRs 4 and 5 still in review:
migration `20261101220500_item_memory_reassembly` (`carried_from_item_id`,
`item_memory_pack`, `item_memory_carry()`, and the trigger that copies the
lineage pointer forward), `test/sql/item_memory_reassembly.sql`, the pure fold
`src/jobs/reassembly.js` with `test/reassembly.test.ts`, the writer
`recordReassembly` in `src/jobs/lib.js` called by both asset extracts, the
lineage walk in `load.ts`/`dossier.ts`, `inherit_candidates` on `recall_ship`,
and `src/app/ship/memory/inherit.ts`, the `inherit_from` check-and-carry.
**The id measurement it was meant to start with did not run** in that
session (no production read), so the matcher shipped written for either
outcome. All six PRs merged on 2026-11-01. **The follow-up of 2026-11-02**
closed the seam the parallel build left — `remember_ship` now takes
`inherit_from` and calls `inheritMemory` — and ran the measurement: **EVE
replaces a hull's id when it is repackaged and keeps the packaged row's id
when a hull is assembled from it** (see Reassembly, which also says what that
meant for the matcher, re-shaped the same day). **The extension** to every
singleton — blueprints, modules, containers — was planned the same day (see
Extension: every singleton, and PRs 7–11). PR 7 (the generic tools and the
blueprint dossier) was built the same day: `recall_item`/`remember_item` in
`memoryTools.ts` with the ship tools as aliases, the resolver widened to a
type name over what the caller holds, `src/app/ship/memory/nativeVoice.ts`
(the kind and native voice per category, tested), the blueprint fold
`blueprintDossier.ts` (tested) with its loader `loadBlueprint.ts`, and the
skill doc's section renamed "An item's memory".

## Decisions (owner, 2026-11-01)

| Question     | Decision                                                                                                                                                                                                                                 |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Who writes   | The AI, over MCP. A read tool gives it the facts and a write tool stores what it wrote. No model runs inside the deployment, and no model API key is added.                                                                             |
| Who reads    | Whoever can open the ship: the owner, and everyone the ship's share reaches. **The memory follows the share.**                                                                                                                           |
| Ownership    | **The memory belongs to the hull, not to an account.** When the hull is sold or contracted to another player, the memory goes with it, and the new owner's AI adds to it. A buyer with no account here sees it once they register and their extract records the hull. **Keyed on `item_id`, with one holder per id**: whoever we saw holding it last, and edit rights follow them. Repackaging packs the personality away with the hull, and reassembly brings it back wherever the extract can tie the new hull to the old one (see Reassembly). |
| Combat       | Out of scope. No killmail extract, no battle-report links. The memory covers origin, travel, cargo, fuel, fit and crew.                                                                                                                  |
| Accents      | A draft chart is below (faction or race → accent), for the owner to edit.                                                                                                                                                                |

## What the ship knows

Every fact comes from tables the extracts already write. **This plan adds no ESI
call and no new scope.**

| The ship remembers         | Source                                                                                                                                                                                                                                                                                                                                                      | What it cannot see                                                                                                                                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Its names                  | `name` on `character_asset_version` / `corp_asset_version`. The name is part of the reconcile's change signature, so a rename opens a version.                                                                                                                                                                                                             | A name held between two extracts.                                                                                                                                                                          |
| Its first sighting         | The `valid_from` of the earliest version of its `item_id`, across all of the account's registrations and corporations.                                                                                                                                                                                                                                    | This is its debut in our data, not its birth. A hull already in the hangar at the registration's first `character-assets` heartbeat predates our record, and the dossier says so instead of inventing an origin. |
| Where it came from         | A match on type and time at the first sighting, tried in this order: (1) a delivered manufacturing job (activity 1) of ours whose `product_type_id` is the hull type; (2) a completed item-exchange or auction contract carrying the type; (3) a market buy of the type (`character_wallet_transaction.is_buy`); (4) **reassembled**: a packaged stack of the type at the same place, under the same owner, shrank or vanished at the debut (a successor version of the stack at the same size is a repack, not an assembly). The plan's rule for a hand-over between alts is not an origin rule as built: the debut is the earliest version across every owner of the account, so a hand-over is reported as a second entry in the dossier's `owners` chain instead. The window is one extract interval before the debut (6h for a character hangar, a day for a corporation's), inclusive; one candidate is `high` confidence, several of one kind are the nearest at `medium`, with the count reported. A cancelled or reverted job never counts, nor does a courier. Where the reassembly matcher tied the hull to an earlier one (`carried_from_item_id`), the dossier also walks back through that hull's history, so the itinerary covers the ship's whole life. Otherwise the dossier says the hull has no known past. | No table links an output item to its job, contract or transaction. The match is "same type, within one extract interval before the debut", so it is reported with its evidence and a `confidence`.            |
| Where it has docked        | The ship's version chain. Each version's root place comes from `character_asset_location` / `corp_asset_location`. Consecutive repeats are collapsed, and dwell time is measured per stop.                                                                                                                                                                  | Samples come every 6h. The route between docks is invisible: `character_location` is one live row with no history.                                                                                          |
| Who has flown it           | `character_ship_over_time` rows for its `ship_item_id`.                                                                                                                                                                                                                                                                                                     | `character-status` samples every 6h, so a short sortie between samples is missed.                                                                                                                         |
| What it has carried        | Child versions whose `location_id` is the ship and whose flag is a hold (cargo, fleet hangar, ore hold, …). Each child `item_id` counts once, at its largest quantity aboard. Volume comes from the SDE. | Anything loaded and unloaded between two extracts. The figures are "at least" figures.                                                                                                                       |
| Its fuel                   | `SpecializedFuelBay` child quantities over time, measured against the hull's `specialFuelBayCapacity` (`panels.ts` already maps that attribute): time-weighted mean fill, lowest fill, fuel type.                                                                                                                                                                | Only hulls that have a fuel bay.                                                                                                                                                                           |
| Its fit and its refits     | Slot-flagged children across versions: the current fit, and how many distinct fits it has had.                                                                                                                                                                                                                                                              | A refit and reversal between two extracts.                                                                                                                                                                  |
| Whether it still exists    | The `sightingOf` result from `lastSeen.ts`, as the ship page already shows it.                                                                                                                                                                                                                                                                              | A hull that vanishes without being repackaged (destroyed, or sold to someone not registered here) keeps its memory on its id, and a buyer who registers later finds it there. A repackaged hull's memory waits for reassembly. |

A pure fold, `src/app/ship/memory/dossier.ts` (tested), turns the rows into the
dossier. The fold produces facts only, never prose. One loader reads the rows,
for character hulls and corp hulls alike. It walks the version chain by
`item_id`, so a hull handed between alts keeps one history.

**The dossier is always the reader's own data.** It goes through RLS on the
caller's bearer client, so a buyer's dossier starts at the day the buyer's
extract first saw the hull. The seller's docks, cargo and pilots never reach
the buyer as data. **The memory text is the only thing that crosses a sale.**
It is a deliberate, authored channel, and the raw history stays with whoever
recorded it.

## The voice

### Accent

The order is the type's **faction** first (`factionID`), then its **race**
(`raceID`), then neutral. The pure module `src/app/ship/memory/accent.ts`
maps the ids to the chart below: `voiceOf({ factionId, raceId })`. It keys on
ids, not on the names in the mirrored `sde_factions` / `sde_races` tables, so
the loader reads two columns of `sde_published_type` and nothing else, and a
CCP rename cannot drop a hull to neutral. A faction with no row (The
Syndicate, EverMore, Rogue Drones, …) falls through to the race. The test
reads this chart from this file and pins every row against the module, so
an edit here fails until `accent.ts` matches. **Confirmed against the mirror on
2026-11-01:** 1,385 types carry `factionID`. The Gila, for example, has
`factionID` 500010 (Guristas) and `raceID` 1 (Caldari), which is why the
faction has to come first. Every empire hull carries one too (a Rifter is
500002), and Navy Issue hulls carry their empire's (the Caldari Navy Hookbill
is 500001, Caldari State), so the "Caldari Navy" half of the drill sergeant's
row is reached only through Mordu's Legion Command (Garmur, Orthrus,
Barghest). PR 2 adds a `faction_id` column to `sde_published_type`. If a hull
has neither a faction nor a race, the voice is neutral. A hull's name is never
used to guess its faction.

**Draft. The owner edits this chart.**

| Faction / race                 | Accent                                                     | Voice notes                                                                                                                         |
| ------------------------------ | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Amarr Empire                   | Received Pronunciation with a cathedral cadence             | Speaks of duty and the Scriptures. Addresses the pilot as "Holder". Latinate words, long sentences. Signs off "Amarr victor."      |
| Ammatar Mandate                | RP learned late, and overcorrected                         | A convert's zeal. More Amarr than the Amarr. Bristles at the sight of Minmatar hulls.                                               |
| Khanid Kingdom                 | Courtly and legalistic                                     | Speaks to the pilot as though petitioning a court. Keeps the paperwork for every jump. Cousin to the Amarr, and proud of the distance. |
| Caldari State                  | Finnish-inflected English, flat and clipped                | Talks like a quarterly report. Says "we", meaning the corporation. Measures every trip in efficiency.                               |
| Caldari Navy / Mordu's Legion  | Texas drill sergeant                                       | Short orders. "Squared away." Respects a full ammo bay.                                                                             |
| Gallente Federation            | French                                                     | Romantic, argumentative, a little vain about its own lines. Liberty, wine and good docking lights.                                  |
| Serpentis                      | Riviera-smooth; a pharmaceutical sales rep                 | Charming, deniable. Never says what was in the cargo hold.                                                                          |
| Minmatar Republic              | Scots burr                                                 | Rust and pride. "It's held together, hasn't it?" Talks about the tribes, the Elders, and freedom.                                   |
| Thukker Tribe                  | Sing-song caravan lilt                                     | A nomad. Measures life in stops, not systems. Never likes staying docked long.                                                      |
| Angel Cartel                   | Cockney wide boy                                           | Always working an angle. Fast, flashy, keeps a second set of books.                                                                 |
| Guristas Pirates               | Australian larrikin                                        | Jokes at the worst moments. Proud of its drones. Calls the pilot "mate".                                                           |
| The Blood Raider Covenant      | Whispered gothic, horror-film Transylvanian                | Devout in a way that makes the crew uneasy. Talks about blood and harvest.                                                          |
| Sansha's Nation                | A chorus; a flat newsreader voice spoken a thousand times  | Always "we". Calm, total and certain.                                                                                               |
| Servant Sisters of EVE         | Soft Irish                                                 | A nurse who has seen too much. Gentle, tired and kind. Counts the survivors.                                                       |
| The Society of Conscious Thought | Unplaceable and unhurried                                | Monastic. Answers a question with a better question.                                                                                |
| CONCORD Assembly               | Mid-Atlantic newsreel announcer                            | Bureaucratic. Cites regulations. Everything is "pursuant to".                                                                       |
| ORE                            | Yorkshire pit village                                      | Blue-collar, patient, dry. Respects the rock. Counts in m³.                                                                         |
| Jove Empire                    | No accent at all                                           | Every word exact. Faintly too old. Slightly disappointed in everyone.                                                               |
| Triglavian Collective          | Slavic, liturgical                                         | Speaks in threes. "Clade", "Flow", "Proving". Every trip a trial.                                                                   |
| EDENCOM                        | Military radio brevity                                     | "Copy." "Wilco." Status reports. Remembers the invasion. This site's own namesake, so give it its due.                              |
| Deathless Circle               | Gravel and gallows humour                                  | A convict's voice. Has seen Zarzakh. Laughs at fines.                                                                               |
| Drifters / Sleepers            | Speaks seldom, in fragments                                | One word, a long silence, then three more.                                                                                          |
| _neutral_                      | Plain spacer                                               | An unplaceable working voice, for anything the SDE does not place.                                                                  |

### Register by hull class

The accent is where the ship comes from. Its hull class is how old it sounds.

| Hull class                          | Register                                     |
| ----------------------------------- | -------------------------------------------- |
| Frigate, destroyer                  | Young and eager; brags                       |
| Cruiser, battlecruiser              | Seasoned; has opinions                       |
| Battleship                          | Grand, slow, sure of itself                  |
| Industrial, freighter, jump freighter | A weary teamster who knows every dock      |
| Mining barge, exhumer, Orca, Rorqual | Patient; talks about the rock               |
| Capital, supercapital               | Ancient and ponderous; remembers everything  |
| Shuttle, corvette, capsule          | Small and earnest                            |

### An example

What a memory might look like for a Minmatar hauler (fictional data):

```markdown
# The Rusty Kettle — Wreathe

Built in our own yard at Rens, hangar six, on YC127-03-14. Aye, I remember the
first undock. Smelled of fresh weld.

## Where I've been

- Rens, mostly. Seventy-one days docked there, and I'll not apologise for it.
- Hek, eleven runs. Never liked the queue at the undock.
- Amamake, once. We don't talk about Amamake.

## What I've carried

At least 412,000 m³ of it, near half of it Tritanium. Hauled a cargo hold of
Quafe once, and the pilot never told me who it was for.

## Who's flown me

Two pilots. The first one babied me. The second one keeps me light.
```

## Storage

`item_memory_over_time`, SCD-2 like the rest of the schema, with the view
`item_memory` showing the current rows:

| Column                       | Note                                                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                         | Identity. A memory's version id; the write tool's optimistic-concurrency handle.                                                                             |
| `item_id`                    | The hull. **The key: one memory per hull, whoever owns it.** EVE never reuses an item id, and a hull keeps its id through every trade, so the memory passes to a buyer. No foreign key, because a memory outlives the asset row: a packed hull's memory waits for reassembly, and a dead id's rows stay with their authors (`written_by`) and on the dead hull's share link. |
| `carried_from_item_id`       | Set by `item_memory_carry()` on the first version under a reassembled hull's new id, naming the id it was carried from, and **copied onto every later version of that item** by a `before insert` trigger (`item_memory_inherit_lineage()`, invoker rights: it reads the version the writer just closed, which `closed_by` makes theirs to read). So the holder reads the pointer on the current row, and no column grant was added: a direct write still cannot name it. Chained through the earlier id's versions, it is the ship's lineage across every repackaging. PR 6. |
| `written_by`                 | The account that wrote this version. Provenance only: it grants no write access, though it does let the author keep reading what they wrote after selling the hull (see RLS). `on delete set null`: a deleted account leaves its text with the hull. |
| `closed_by`                  | The account that superseded this version. Not in the first draft of this plan; PR 2 found it necessary (see RLS). `on delete set null`.                         |
| `type_id`                    | The type at write time, so a dead hull's memory still knows what it was.                                                                                     |
| `body`                       | Markdown, at most 20,000 characters and not blank (a check constraint).                                                                                     |
| `author`                     | Provenance: the MCP client's name where the protocol supplies one, else `mcp`.                                                                               |
| `is_current`, `valid_from`, `valid_until` | The usual SCD-2 columns. A unique partial index on `(item_id) where is_current`.                                                                   |

### One holder per item id

**An item id has exactly one holder: whoever we saw holding it last.** The
memory's edit rights follow that holder.

- **Within each hangar table this already holds.** `character_asset_claim()`
  and `corp_asset_claim()` (migration `20260831043706_asset_handoff_claim`)
  close the open row for each incoming `item_id`, whoever holds it, in the
  same transaction that inserts the new row. The unique partial index on
  `item_id where is_current` backs that up, across every registration on the
  character side and every corporation on the corp side. So when a buyer's
  extract first lists the hull, the seller's row closes in that same
  transaction. The seller's next run finds nothing to close, because the hull
  is missing from their listing.
- **Across the two tables it does not hold today.** Neither claim function
  touches the other table, so a hull moving between a character hangar and a
  corp hangar (given to the corp, a contract made out to a corporation, a
  director moving it out) stays current in both until the old holder's next
  pull. That is up to 6h for a character, a day for a corporation
  (`corp-assets` is daily), and a week while a role denial pauses a
  corporation's pulls. **PR 1 closes that gap:** each claim function also
  closes the _other_ table's current row for the incoming ids. Both functions
  take both advisory locks, always in the same order (character first, then
  corp), so that a character claim and a corp claim racing for one item cannot
  deadlock. The extra cost is one indexed update per claim chunk. Its test is
  `test/sql/asset_claim_cross_hangar.sql`.
- **Measured on production, 2026-11-01**, before merging PR 1:
  - 12 ids were current in both tables. All 12 were one handoff, corp →
    character: 11 BPOs and a packaged Athanor, waiting on that day's corp
    pull.
  - Since 2026-10-05 there were 3,299 overlaps across 2,240 items: 1,312
    cleared within 6h, 1,974 within 25h, and none between 25h and 3 days.
  - The 13 that lasted longer were one Prospect and its 12 fitted modules,
    open in both hangars for 5 days. The corporation's extract skipped on a
    role denial 5 times in that window and pulled 0 times.
  - So every overlap was a handoff waiting on the old holder's pull. None was
    an item ESI lists in two hangars at once, which is the case where this
    fix would churn versions.
- **"Last" means our run clock, not ESI's snapshot time.** ESI caches an
  asset listing for up to an hour. A previous holder's listing fetched just
  after the trade, but cached from before it, could claim the hull back until
  their next run. That needs a trade, the buyer's run and the seller's run all
  inside one cache hour. If it shows up in practice, the fix is to compare the
  listing's `Last-Modified` with the holder's, not to add a grace period.

As a result, **write access follows the hull, with no overlap.** Whoever holds
it can write, whether it sits in a character hangar of theirs or in the hangar
of a corporation they belong to. At the buyer's first sighting the seller loses
both reading and writing, and the buyer gains both. On a corp hull every member
writes the one memory. There are no per-member copies.

The only way to write is `item_memory_write(item_id, body, based_on)`, a
SECURITY INVOKER function, so that closing the old version and opening the new
one happen in one transaction. Two PostgREST calls cannot do that. As built
it is `item_memory_write(p_item_id, p_body, p_based_on, p_author default
'mcp')`, returning the new version's id (the next write's `based_on`). It
refuses:

- an item the caller does not **hold**. The function probes the hull's one
  current asset row, of which there is one across both hangars (see One holder
  per item id), and tests that row's owner explicitly against the caller's
  registrations and `my_corporation_ids()`. **Seeing a row is not owning it**
  here either: `character_asset` also returns rows shared with the caller, and a
  share recipient must not be able to write. The asset rows come from ESI
  through the extracts, so nobody can claim a hull they do not hold in game.
  SQLSTATE `42501`.
- a stale write: `based_on` must be the current version's id, or null when no
  memory exists yet. Two conversations writing the same ship (or two members of
  the corporation holding it) must not silently overwrite each other. The
  second write is told to re-read. SQLSTATE `PT409`, which PostgREST answers
  as HTTP 409. A racing close is serialized by the row lock (the loser reads
  `is_current` false and closes nothing), and two racing first writes by the
  unique index.

RLS for select: `written_by = auth.uid() or closed_by = auth.uid() or
(is_current and holds_item(item_id))`.

**Why `closed_by`.** Under invoker rights Postgres checks an `UPDATE`'s new
row against the SELECT policy, and refuses the statement when the row would
vanish from the caller's view. With the first draft's policy, a buyer closing
the seller's version (written by the seller, no longer current) could not
read the row they had just made, so the very first write after a sale failed.
`closed_by` keeps the closed row readable to whoever closed it. That reveals
nothing: the closer read it as the current text a moment before.

**Direct writes.** RLS is the gate, not the function. `authenticated` may
insert only `item_id`, `type_id`, `body` and `author` (the account, the flag
and the timestamps are defaults), and update only `is_current`,
`valid_until` and `closed_by`, under a policy that lets a holder close the
current version and nothing else. So a holder writing the table directly can
do what the function does, less the check that they read the version they
replace. No delete, no anon.

- **The current holder reads the current text,** including what earlier owners
  wrote, since that is what the ship remembers.
- **Every author keeps reading their own versions,** so a seller can recover
  what they wrote. **Every closer keeps the versions they superseded,** which
  they had read already.
- **A superseded version by a former owner is not visible to the new holder.**
  If a seller rewrote the memory to drop something before selling, the dropped
  part stays dropped.

`holds_item()` is the same ownership probe the write function uses. It is
SECURITY INVOKER and costs one indexed lookup per row on a small table. Share
recipients do not read the table directly. The share-scoped loader reads it on
the service role (see Display). The tests, `test/sql/item_memory.sql`, cover a
sale in particular: the seller loses read and write at the buyer's first
sighting, the buyer gains both, and the seller's old versions stay theirs
alone.

## Reassembly

A repackaged hull's personality goes back into the hull that is assembled from
it, wherever the extract can tie the two together.

**First, measure what EVE does to the id.** The PR 3 session tried and was
refused a production read, and the PR 6 session had no production credentials
at all, so **the measurement is still owed** and runs after the merge:
among ship-category item ids in `character_asset_version`, count the ids seen
both assembled and packaged against the ids seen in only one of those states.
`is_singleton` is in the reconcile's signature, so a flip on one id opens a
version. Separately, check whether a stack of one keeps its id through a trade.
There are two possible outcomes:

- **The id survives a repackage**, so `is_singleton` flips on one id. The
  memory never left the hull, and the matcher only matters when the packaged
  hull is merged into a stack, which does give it a new id.
- **The id is replaced.** The matcher below is the whole mechanism.

The matcher is written so that it works under either outcome. Under the first
it rarely fires. As built it never reads a vanished row's singleton flag: a
memory on a packaged row of one unit (the first outcome, before the row
merges into a stack) is treated as the hull it is.

**Measured on production, 2026-11-02**, over every ship-category item id in
`character_asset_version` (10,961 ids): 8,055 were only ever seen assembled,
2,804 only ever packaged, and 102 in both states. Ordering each id's versions
by `valid_from`, **all 102 flips go packaged → assembled and none goes
assembled → packaged**. So the second outcome holds for a repackage: the
assembled id is gone and the packaged stack is a new id, which is exactly the
_vanish_ the pack event is built on. But assembly is not the mirror image:
**the assembled hull keeps the packaged row's id**. 85 of the 102 came out of
a stack of one, and 17 out of a larger stack (2 to 31 units), where the stack
id became the hull and the remainder went on under another id. Separately,
53 single-unit packaged ids were seen under two of our registrations, so a
stack of one keeps its id through a transfer, as rule 2 hoped.

That had a consequence the plan did not foresee. The unpack event as first
built was _an assembled hull made its debut_, and `carriesOf` considered
`debuts` alone, but a hull assembled from a packed stack is not a debut: it is
the stack's own id flipping `is_singleton`, which the reconcile hands over as
a `changed` row. Rule 2 likewise waited for the pack's stack to _shrink or
vanish_, and a flipped id does neither. So as shipped on 2026-11-01 the
automatic carry could never fire. **The matcher was re-shaped the next day**
(the PR after the `inherit_from` follow-up): the reconciles now hand each
changed row its `previousSingleton` beside `previousQuantity`, a **flip** —
`is_singleton` false a run ago, true now — is the unpack event, and rule 2 on
a flip is identity: the pack's `stack_item_id` _is_ the hull's id. The
paragraphs below describe the matcher as it stands.

**The events.** Each asset run's reconcile already knows which item ids
vanished from the listing and which made their debut. Every closed row is not
a vanish: a rename, a move or a quantity change also closes a row, so the test
is that the item id is _gone_. From those sets the run derives two events:

- **Pack**: a hull with a memory vanished, and in the same run a packaged stack
  of its type at the same place appeared or grew, under the same owner. This
  writes a pending row to `item_memory_pack`: the hull, its type, the owner
  (registration or corporation), the stack's item id, the place, and when it
  was packed. A hull that vanished with no stack appearing was destroyed or
  traded away assembled, which is not a pack. As built, when several stacks
  of the type grew at that place in one run, the pack records the place and
  **no stack** (`stack_item_id` null): rule 3 can still find the hull again,
  rule 2 cannot.
- **Unpack**: a hull of type T was assembled. Two shapes. A **flip**: a
  changed row that was a stack a run ago and is a singleton now — the
  measured shape, since EVE gives the assembled hull the packaged row's id,
  whether that row held one unit or thirty-one (the remainder of a larger
  stack goes on under a new id, debuting as a stack, which is nothing to
  carry into). A **debut**: a singleton with no earlier version under any
  owner, the one shape a flip cannot show — a hull repackaged and reassembled
  inside one interval, whose fresh stack id was never seen as a stack. A
  debut with a closed asset row under any owner is a hull back from a trip,
  not a new id, and is never carried into (`isNewId` in `lib.js`); a flip's
  closed rows are its own packaged past, so the test is skipped for it.

**The matching**, in order. The first rule that yields exactly one candidate
wins:

1. **Within one interval** (a debut only). A memory-bearing hull of type T
   vanished in the same run, at the same place, under the same owner, and no
   stack of the type there changed — a stack that flipped counts as changed:
   it was repackaged and reassembled between two extracts.
2. **The stack it went into.** For a flip, every pending pack naming the
   flipped id as its stack: the pack's stack _is_ the hull, so one pack is
   carried with certainty and two are the ambiguous case. For either shape,
   a pending pack whose stack shrank or vanished in this run (the fallback
   should EVE ever hand the remainder the old id). Both match under any
   owner, so a stack keeping its id through a trade — measured: 53 single-unit
   packaged ids seen under two of our registrations — takes the memory to the
   buyer, as an assembled hull does.
3. **Same owner and place** (a flip only). A pending pack of type T under the
   same owner at the same place: the pack that could name no stack because
   several grew at once. Never for a debut — a hull bought on contract or
   delivered from a build debuts too, and the first build matched it here,
   which would have given a new hull another ship's past.

If no rule yields a candidate, the hull starts blank. If a rule yields several
candidates (two named hulls of one type packed into one stack, which the game
itself can no longer tell apart), **nothing is carried**: `recall_ship` lists
the candidates, and the owner picks one through `remember_ship`'s
`inherit_from`. As built, "the first rule that yields exactly one candidate
wins" is read as _the first rule that yields any candidate decides_: an
ambiguous rule does not fall through to a later rule that happens to be
clean, since the later rule's one candidate is no more likely to be the hull
than the earlier rule's several. Two debut hulls in one run that both point
at one memory are both left for the owner, for the same reason. A debut hull
with a closed asset row under any owner is a hull back from a trip, not a new
id, and is never carried into. `recall_ship` lists the candidates as
`inherit_candidates` — the caller's pending packs of the hull's type, when
the hull has no memory and is in the hangar — and the check-and-carry behind
`inherit_from` is `src/app/ship/memory/inherit.ts` (`inheritMemory`: the pack
is the caller's and pending, the hull is held and of the pack's type and has
no memory, all on the bearer client; then `item_memory_carry()` on the
service role). The `remember_ship` parameter that calls it landed in the
2026-11-02 follow-up, after PRs 4 and 6 had both merged.

**The carry.** The service role opens a version under the new id with the old
body, keeps `written_by`, sets `author` to `reassembly` and
`carried_from_item_id` to the old id, closes the old id's current version, and
marks the pack resolved. From then on the new hull is an ordinary hull: its
holder reads and writes it under the same rules. Superseded versions on the
old id stay with their authors.

**Where it runs.** As a best-effort step after the `character-assets` and
`corp-assets` reconciles, in the shape of `recordStructureTenancy`
(`recordReassembly` in `src/jobs/lib.js`). A failure there never fails the
extract. Each reconcile already keeps, beside every current row's signature,
the four facts the fold reads (type, place, quantity, singleton), and hands
the step the ids that vanished, the ids that debuted and the rows that
changed with their previous quantity. The step costs at most two indexed
probes per run: the memories among the vanished ids (`item_memory`, chunked),
and, only when a singleton debuted, every pending pack (the table is tiny: a
row needs a memory-bearing hull to have been repackaged, so one read is the
whole set, under any owner, which is what rule 2 needs). Both almost always
come back empty, so the reconcile itself does no new writes. A carry adds one
indexed probe per asset table for the new-id test. The pure fold is
`src/jobs/reassembly.js` (tested), covering the three rules, the vanish test,
and ambiguity. The carry runs after the claim has opened the debut rows, since
`item_memory_carry()` reads the new hull's current asset row for its type.

## MCP tools

Both tools live in a new module, `src/app/api/mcp/memoryTools.ts`, and both run
on the caller's bearer client.

- **`recall_ship(ship)`**: read-only. `ship` is an item id (a run of five or
  more digits), or a name matched over the caller's own hulls, current and
  dead, with ambiguous matches refused (the `match.ts` rule; a dead hull is
  listed as "no longer held"). Corp hulls carry no name in ESI, so a corp hull
  is reached by id. The dossier is loaded only for the caller's own owners
  (`fetchOwnerContext`), never for a hull someone shared with them. It answers the dossier above, the accent and register,
  the current memory with its version id, and **who can read the memory**: the
  share rows whose subject is the hull, a container above it
  (`asset_ancestors()`), or its place. The AI can then tell the player "this
  ship is shared publicly, so the memory will be too" before it writes. It
  also says which parts of the memory came before the caller's ownership, so
  the AI knows the voice it inherits: the current version's `written_by` is
  another account, and the hull's earliest version in the caller's own data
  is later than the memory's first write.
  Annotations: `readOnlyHint: true`, `openWorldHint: false`.
- **`remember_ship(ship, memory, based_on, author?, inherit_from?)`**: a write tool. It
  stores the whole new text through `item_memory_write`. On a stale
  `based_on` it answers "the memory changed since you read it; call
  `recall_ship` again", and it never merges. An unheld hull is refused with
  the function's `42501`, read as "you do not hold it now"; the body is
  checked against the storage's limits (blank, 20,000 characters) before the
  call so the refusal says what is wrong. `author` is the client's name,
  since the server context carries none; default `mcp`. The answer repeats
  who reads the text (the same `readers` as `recall_ship`). With
  `inherit_from` (a pending pack of the caller's, of the same type, on a hull
  that has no memory yet) it settles an ambiguous reassembly, running the
  carry first and then writing the new text on top of the carried version
  (`based_on` must be null; the answer carries `inherited`). The check-and-carry
  is **PR 6**'s `inherit.ts`; the parameter landed in the 2026-11-02
  follow-up. Annotations: `readOnlyHint: false`, `destructiveHint: false`
  (every version is kept), `idempotentHint: false`.

The procedure goes in `docs/edencom-industry-SKILL.md`, which `get_skill`
serves, as a section called "Writing a ship's memory":

1. Call `recall_ship`.
2. Write in the accent and register it names.
3. Keep what the old memory said unless the facts contradict it. Add, don't
   rewrite.
4. Use "at least" where the data is sampled.
5. Never invent battles, cargo or places.
6. The memory is read by everyone the ship is shared with, **and by whoever
   owns it next**. Before naming places or pilots, check who that is. A buyer
   inherits the text, not the data.
7. On a hull with an earlier owner, keep that owner's chapters as the ship's
   past ("Before you, I hauled for…"). Don't erase them.

## Display

On `/ship/[itemId]`, a **Memory** panel below the fitting stack renders the
markdown with raw HTML disabled, and opens links with
`rel="nofollow noopener"`. The panel shows "written N times, last on …", and
when no memory exists it shows nothing. **As built**, images are not drawn
either (`disallowedElements: ['img']`, unwrapped to their alt text): an image
URL in a text an AI wrote would send every reader's address to whoever hosts
it. "Written N times" counts the versions up to the one shown, so a dead
hull's link never counts a buyer's later writes (`select.ts`, tested).

- **The holder** sees the hull's memory, read on the cookie session. **A
  signed-in share recipient** opening the plain `/ship/[itemId]` (no
  `?share=`) reads the hull's row through the audience policy but holds
  nothing, so that read is empty for them; the page then reads the memory
  on the service role, since the hull row having come through RLS is the
  proof a share reaches them — the same answer the share loader gives.
- **A share recipient** sees the same memory, read through `sharedShip.ts` on
  the service role. That loader already resolved the share, so it stays the
  one gate. A hull has only one memory, so there is no question of whose to
  show.
- **A dead hull's share link**, which outlives the hull per `lastSeen.ts`,
  shows the memory as it stood when the hull was last seen. A share names an
  item id, so **a share does not carry across a reassembly**: the reassembled
  hull starts unshared, whatever its memory says (see the open questions).
- **On a share with `show_as_main` the memory is hidden.** That flag promises
  that the page sends nothing that leads to the holder, and no code can check
  free text written by an AI. See the open questions.
- **The share card (`card/route.tsx`) does not draw the memory** in v1. A chat
  preview stays an image of the hull.

The Share dialog on a hull gains one line when a memory exists: "This ship's
memory is shown to everyone this reaches." The Memory panel itself carries a
standing note: "Goes with the ship if you sell it."

Markdown rendering needs a dependency, because the repo had no markdown
renderer. PR 5 added `react-markdown` (10.x) without `rehype-raw`, so raw
HTML is never rendered, with `skipHtml` so its text is dropped too.

## Extension: every singleton (planned 2026-11-02)

The storage was built per item id rather than per ship, and on 2026-11-02 the
owner set the goal that **every singleton item we track can carry a memory
through this one mechanism**: a Vexor Blueprint Original answers how many
hulls it has built the way a Phoenix Navy Issue answers where it has docked.
This chapter is the plan for that, measured against production the day it
was written; nothing above is undone by it. The extension's PRs are 7 to 11
in the list below; PR 7 is built, the rest are not.

### Decisions (owner, 2026-11-02)

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

### What the data already does

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

### What "every singleton" is

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

### What each kind of item knows

The ship dossier (`src/app/ship/memory/dossier.ts`, "What the ship knows"
above) stays as it is. Each other category gets a fold of its own beside it,
and a **generic** fold covers anything without one. Every fold answers the same envelope: the facts,
the voice, the current memory with its version id, `before_you`, the readers,
`inherit_candidates`, and the `how` paragraph. A `kind` field names which
dossier answered.

#### Blueprint

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

#### Module

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

#### Container

CCP files cargo and secure containers under category Celestial. A container's
dossier is its places and what it has held: every item whose `location_id`
was the container, as spans, with at-least quantities — the ship dossier's
cargo fold applied to a different parent. Containers are named in ESI, so
they resolve by name like hulls.

#### Everything else

Drones, charges, subsystems, deployables, structure modules and anything the
plan has no fold for take the **generic** dossier: names if ESI names it,
debut and origin, the places it has been and the owners it has had, whether
it is held now. A drone in a bay is a child of its hull like a module, so the
generic fold reports the parents it has sat in; a module-specific attachment
fold is not needed for the voice to work there, since drones keep the droid
voice without acquiring accents.

### The voice, generalised

The ship's voice above has two parts: an **accent** from the hull's faction
and race (`accent.ts`, keyed on SDE ids) and a **register** from its hull
class (`register.ts`). Both stay. Two things are added.

#### A native voice per category

| Category              | Native voice                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ship                  | As above: accent by faction and race, register by hull class.                                                                               |
| Module (not high-slot) | A robotic droid with a limited vocabulary. Short declaratives, status words, numbers. No accent of its own; the accent column reads "droid".           |
| Module (high-slot)    | The same droid, but a brutish thug: blunt, proud of damage dealt or ore pulled, impatient with idle time. Acquires the accents of its hulls (below).   |
| Blueprint             | **Owner's call.** A draft to edit: a patient clerk who counts in runs and remembers every pilot who ever put it in a slot. Its register is its research: ME 0 is a novice, ME 10 / TE 20 has seen everything. |
| Container             | **Owner's call.** Draft: a warehouse foreman; talks about what passed through.                                                                        |
| Everything else       | The droid, without the thug.                                                                                                                            |

The chart is a table in this doc pinned by a test, as the ship accent chart
is; the pure module is `src/app/ship/memory/nativeVoice.ts`.

#### Acquired accents

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
`sde_region` view exposes `region_id` and `name` only. PR 9 adds
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

### Resolving an item

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

### Display

- The Memory panel is drawn by `/asset/[locationId]` for a container, read
  the way the ship page reads it (holder's session, else service role once a
  share proved reachable).
- Blueprints and modules have no page. `/item/:itemId` is today a redirect to
  `/ship/:itemId`; PR 10 makes `/item/[itemId]` the generic item page — the
  item's identity strip, its dossier facts and the Memory panel — and keeps
  redirecting ships to `/ship`. A share link to one unfurls through the
  generic `summaryCard`, per the "every share link unfurls" rule.
- `/bpos/[name]` could link each original to its item page; not in this plan.

### MCP tools

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

### Reassembly for other categories

The fold already runs for every memory-bearing singleton. A module that is
unfitted and repackaged becomes a stack of one under a new id — the pack event
— and is assembled back into a module under that stack's id — the flip. The
pack table's `type_id` and the carry's type check hold for any category.
Blueprints never reach it. Nothing to build.


## PRs

1. **One holder per item id.** Each `*_asset_claim()` also closes the other
   table's current row for the incoming ids, with both advisory locks taken in
   a fixed order. First the read counting item ids current in both tables
   today. Then `schema.sql`, a migration, and
   `test/sql/asset_claim_cross_hangar.sql`. This fixes the asset layer itself,
   since a ship given to the corp shows in both hangars today, so it is worth
   landing before anything else here.
2. **Storage and accent.** The `item_memory_over_time` table, its view,
   `item_memory_write()`, `holds_item()`, RLS, `test/sql/item_memory.sql`
   (including the sale case), plus `schema.sql`
   and a migration. `accent.ts` with the chart (pure, tested). The
   `faction_id` column on `sde_published_type` (a `schema.sql` view change
   plus a migration; the mirror job defines no views). Built 2026-11-01.
3. **The dossier and `recall_ship`.** The loader (character and corp hulls,
   across alts), the pure fold `dossier.ts` (names, debut, origin inference,
   itinerary, pilots, cargo, fuel, refits; tested hard, because the inference
   windows are the whole tool), and the read tool. Built 2026-11-01. The
   register chart got its own pure module (`register.ts`) beside the accent,
   and the fuel-bay capacity its own SDE reader (`src/sdeDogma.ts`), since
   the ship page reads dogma only in the browser. "Record start" is the
   owner's earliest asset version rather than a heartbeat: the first extract
   wrote every item at once, and heartbeats are not kept forever.
4. **`remember_ship` and the skill section.** Built 2026-11-01, without
   `inherit_from` (PR 6); the parameter landed in the follow-up of
   2026-11-02.
5. **Display.** The Memory panel, the share-loader read, the `show_as_main`
   rule, the Share-dialog line, and the markdown dependency. Built
   2026-11-01.
6. **Reassembly.** First the id measurement. Then `item_memory_pack`,
   `carried_from_item_id`, the fold `src/jobs/reassembly.js`, the post-reconcile
   step in both asset extracts, `inherit_from`, and the dossier walking the
   lineage. Built 2026-11-01, without the measurement (no production read in
   that session; it is owed after the merge). `inherit_from` shipped as the
   lib `inherit.ts` plus `recall_ship`'s `inherit_candidates`; the parameter
   on `remember_ship` landed in the follow-up of 2026-11-02, which also ran
   the measurement (see Reassembly) and found the matcher's unpack event
   needed re-shaping; the PR after it re-shaped it around the singleton
   flip, with `previousSingleton` on the reconciles' changed rows and `via`
   on every carry.

The extension (planned 2026-11-02, nothing built):

7. **Generic tools and the blueprint dossier.** `recall_item` /
   `remember_item` with the ship tools as aliases, the widened resolver
   (name, then type name), the generic dossier, and the blueprint fold over
   the job and blueprint histories (pure, tested; the Vexor table above is
   its acceptance test). Skill doc section renamed. This alone answers the
   owner's question. **Built 2026-11-02.** Where it differs from the plan:
   the generic dossier is the ship fold itself — `dossier.ts` folds any
   asset item's versions, and the ship parts (pilots, fuel, fit) come back
   empty for a blueprint — so no separate generic fold was written, and the
   tool draws the sections a kind has (a container keeps the cargo fold as
   `contents`). The native-voice chart shipped in this PR as
   `nativeVoice.ts` (the thug by current slot, the clerk's register by
   research), ahead of PR 8, since the tool had to say some voice for every
   kind; the acquired accents stay PR 8. A blueprint's `installers` are
   named through the world-readable `character_directory`.
8. **Module dossier and the droid voices.** The attachment fold,
   `nativeVoice.ts` with the chart above, `accentBlend.ts` for high-slot
   modules (tested against hand-built histories: one hull for 100 days is
   0.27, two hulls, a year on each, are two accents at 1.0). The container
   fold rides along, being the cargo fold with a different parent.
9. **Lingo.** `sde_region.faction_id` (view + migration), the region reader,
   the dwell fold, `LINGO_CAP`.
10. **Pages.** `/item/[itemId]` and its card; the panel on `/asset/[id]` for
    containers.
11. **Docs.** This document's early chapters are reread as the ship case of
    the general rules, and the skill doc's "A ship's memory" becomes "An
    item's memory".

## Open questions

- **The `show_as_main` default.** The plan hides the memory on those shares.
  The other option is to show it, and have `remember_ship` tell the AI when a
  covering share has `show_as_main` set so that it avoids naming pilots. That
  rests on the AI's discretion rather than on code.
- **Shares across a reassembly.** The memory comes back after a reassembly,
  but the hull's share does not, because a share names an item id. Carrying
  the share as well would publish a new item that its owner never chose to
  share. The plan leaves the hull unshared.
- **Items other than ships** are the extension above. Its own open
  questions: the **blueprint and container native voices** are drafts for the
  owner, as the accent chart was; **`LINGO_CAP`** at 0.1, and whether lowsec
  and nullsec factions should ever season a hull (the fold takes the band as
  a parameter either way); **charges**, singletons while loaded and consumed
  soon after, which the generic dossier would answer for without the plan
  going out of its way; and **battles** — nothing in the data records combat,
  which is why the writing procedure forbids inventing one. A
  `character-killmails` extract (`esi-killmails.read_killmails.v1`; each
  killmail names the ship item id the victim flew and the attackers' ship
  types) would give hulls their fights and high-slot modules their kills. A
  plan of its own.
- **Higher-resolution history.** Every "at least" above comes from the
  6-hourly extract. Keeping `character_location` as history while a character
  is boarded would give the memory routes, not just docks. That is its own
  project, with its own write-load cost.
