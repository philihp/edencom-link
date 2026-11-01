# Ship memory

A text a ship keeps about itself. Any item a player holds can carry one
markdown document. In practice the item is a ship. The player's AI companion
(Aura, Claude, ChatGPT, over MCP) writes it in the ship's own voice: where it
came from, where it has docked, what it has hauled, how it keeps its fuel, who
has flown it. The AI rewrites it as the ship's history grows, so the memory
accumulates, and every version is kept.

**Status:** 🔨 in progress. PR 1 (one holder per item id) was built on
2026-11-01: migration `20261101065555_asset_claim_cross_hangar` and
`test/sql/asset_claim_cross_hangar.sql`. The measurement it starts with has
not been run (see PR 1). PRs 2–6 are planned.

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
| Where it came from         | A match on type and time at the first sighting, tried in this order: (1) a delivered manufacturing job (activity 1) of ours whose `product_type_id` is the hull type; (2) a completed item-exchange contract carrying the type; (3) a market buy of the type (`character_wallet_transaction.is_buy`); (4) the same `item_id` closed under another of the account's owners, which is a hand-over between alts; (5) **reassembled**: a packaged stack of the type at the same place shrank at the debut. Where the reassembly matcher tied the hull to an earlier one (`carried_from_item_id`), the dossier also walks back through that hull's history, so the itinerary covers the ship's whole life. Otherwise the dossier says the hull has no known past. | No table links an output item to its job, contract or transaction. The match is "same type, within one extract interval before the debut", so it is reported with its evidence and a `confidence`.            |
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
(`raceID`), then neutral. Faction and race names come from the mirrored
`sde_factions` / `sde_races` tables (the mirror makes one table per CCP file).
The pure module `src/app/ship/memory/accent.ts` maps those names to the chart
below, and a test pins every row. **Confirmed against the mirror on
2026-11-01:** 1,385 types carry `factionID`. The Gila, for example, has
`factionID` 500010 (Guristas) and `raceID` 1 (Caldari), which is why the
faction has to come first. PR 2 adds a `faction_id` column to
`sde_published_type`. If a hull has neither a faction nor a race, the
voice is neutral. A hull's name is never used to guess its faction.

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
| `carried_from_item_id`       | Set on the first version under a reassembled hull's new id, naming the id it was carried from. Chained, it is the ship's lineage across every repackaging.        |
| `written_by`                 | The account that wrote this version. Provenance only: it grants no write access, though it does let the author keep reading what they wrote after selling the hull (see RLS). |
| `type_id`                    | The type at write time, so a dead hull's memory still knows what it was.                                                                                     |
| `body`                       | Markdown, at most 20,000 characters (a check constraint).                                                                                                   |
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
  extract, which can be up to 6h. **PR 1 closes that gap:** each claim
  function also closes the _other_ table's current row for the incoming ids.
  Both functions take both advisory locks, always in the same order (character
  first, then corp), so that a character claim and a corp claim racing for one
  item cannot deadlock. The extra cost is one indexed update per claim chunk.
  PR 1 starts with a read: how many item ids are current in both tables right
  now. Its test is `test/sql/asset_claim_cross_hangar.sql`.
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
one happen in one transaction. Two PostgREST calls cannot do that. It refuses:

- an item the caller does not **hold**. The function probes the hull's one
  current asset row, of which there is one across both hangars (see One holder
  per item id), and tests that row's owner explicitly against the caller's
  registrations and `my_corporation_ids()`. **Seeing a row is not owning it**
  here either: `character_asset` also returns rows shared with the caller, and a
  share recipient must not be able to write. The asset rows come from ESI
  through the extracts, so nobody can claim a hull they do not hold in game.
- a stale write: `based_on` must be the current version's id, or null when no
  memory exists yet. Two conversations writing the same ship (or two members of
  the corporation holding it) must not silently overwrite each other. The
  second write is told to re-read.

RLS for select: `written_by = auth.uid() or (is_current and holds_item(item_id))`.

- **The current holder reads the current text,** including what earlier owners
  wrote, since that is what the ship remembers.
- **Every author keeps reading their own versions,** so a seller can recover
  what they wrote.
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

**First, measure what EVE does to the id.** This session tried and was refused
a production read, so the measurement is the reassembly PR's first step:
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
it rarely fires.

**The events.** Each asset run's reconcile already knows which item ids
vanished from the listing and which made their debut. Every closed row is not
a vanish: a rename, a move or a quantity change also closes a row, so the test
is that the item id is _gone_. From those sets the run derives two events:

- **Pack**: a hull with a memory vanished, and in the same run a packaged stack
  of its type at the same place appeared or grew, under the same owner. This
  writes a pending row to `item_memory_pack`: the hull, its type, the owner
  (registration or corporation), the stack's item id, the place, and when it
  was packed. A hull that vanished with no stack appearing was destroyed or
  traded away assembled, which is not a pack.
- **Unpack**: an assembled hull of type T made its debut with no earlier
  version under any owner, so it is a new id and not a hull back from a trip.

**The matching**, in order. The first rule that yields exactly one candidate
wins:

1. **Within one interval.** A memory-bearing hull of type T vanished in the
   same run, at the same place, under the same owner, and no stack changed: it
   was repackaged and reassembled between two extracts.
2. **The stack it went into.** A pending pack whose stack shrank or vanished in
   this run. This rule matches on the stack's item id under any owner, so if a
   stack keeps its id through a trade, a hull sold packaged still takes its
   personality to the buyer, as an assembled one does.
3. **Same owner and place.** A pending pack of type T under the same owner at
   the same place.

If no rule yields a candidate, the hull starts blank. If a rule yields several
candidates (two named hulls of one type packed into one stack, which the game
itself can no longer tell apart), **nothing is carried**: `recall_ship` lists
the candidates, and the owner picks one through `remember_ship`'s
`inherit_from`.

**The carry.** The service role opens a version under the new id with the old
body, keeps `written_by`, sets `author` to `reassembly` and
`carried_from_item_id` to the old id, closes the old id's current version, and
marks the pack resolved. From then on the new hull is an ordinary hull: its
holder reads and writes it under the same rules. Superseded versions on the
old id stay with their authors.

**Where it runs.** As a best-effort step after the `character-assets` and
`corp-assets` reconciles, in the shape of `recordStructureTenancy`. A failure
there never fails the extract. The step costs at most two indexed probes per
run: memories among the vanished hull ids, and pending packs for the owner.
Both almost always come back empty, so the reconcile itself does no new
writes. The pure fold is `src/jobs/reassembly.js` (tested), covering the
three rules, the vanish test, and ambiguity.

## MCP tools

Both tools live in a new module, `src/app/api/mcp/memoryTools.ts`, and both run
on the caller's bearer client.

- **`recall_ship(ship)`**: read-only. `ship` is an item id, or a name matched
  over the caller's own hulls, current and dead, with ambiguous matches refused
  (the `match.ts` rule). It answers the dossier above, the accent and register,
  the current memory with its version id, and **who can read the memory**: the
  share rows whose subject is the hull, a container above it
  (`asset_ancestors()`), or its place. The AI can then tell the player "this
  ship is shared publicly, so the memory will be too" before it writes. It
  also says which parts of the memory came before the caller's ownership, so
  the AI knows the voice it inherits: the current version's `written_by` is
  another account, and the hull's earliest version in the caller's own data
  is later than the memory's first write.
  Annotations: `readOnlyHint: true`, `openWorldHint: false`.
- **`remember_ship(ship, memory, based_on)`**: a write tool. It stores the
  whole new text through `item_memory_write`. On a stale `based_on` it answers
  "the memory changed since you read it; call `recall_ship` again", and it
  never merges. With `inherit_from` (a pending pack of the caller's, of the
  same type, on a hull that has no memory yet) it settles an ambiguous
  reassembly. It runs the carry first, and then writes the new text on top. Annotations: `readOnlyHint: false`, `destructiveHint: false`
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
when no memory exists it shows nothing.

- **The holder** sees the hull's memory, read on the cookie session.
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

Markdown rendering needs a dependency, because the repo has no markdown
renderer today. PR 5 picks one that is safe by default with no raw-HTML pass,
for example `react-markdown` without `rehype-raw`.

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
   `faction_id` column on `sde_published_type` (a `src/jobs/sdeMirror.js` view
   change plus a migration).
3. **The dossier and `recall_ship`.** The loader (character and corp hulls,
   across alts), the pure fold `dossier.ts` (names, debut, origin inference,
   itinerary, pilots, cargo, fuel, refits; tested hard, because the inference
   windows are the whole tool), and the read tool.
4. **`remember_ship` and the skill section.**
5. **Display.** The Memory panel, the share-loader read, the `show_as_main`
   rule, the Share-dialog line, and the markdown dependency.
6. **Reassembly.** First the id measurement. Then `item_memory_pack`,
   `carried_from_item_id`, the fold `src/jobs/reassembly.js`, the post-reconcile
   step in both asset extracts, `inherit_from`, and the dossier walking the
   lineage.

## Open questions

- **The `show_as_main` default.** The plan hides the memory on those shares.
  The other option is to show it, and have `remember_ship` tell the AI when a
  covering share has `show_as_main` set so that it avoids naming pilots. That
  rests on the AI's discretion rather than on code.
- **Shares across a reassembly.** The memory comes back after a reassembly,
  but the hull's share does not, because a share names an item id. Carrying
  the share as well would publish a new item that its owner never chose to
  share. The plan leaves the hull unshared.
- **Items other than ships.** The storage takes any item id. `recall_ship`
  answers only for ships, because a container's dossier would be a different
  fold.
- **Higher-resolution history.** Every "at least" above comes from the
  6-hourly extract. Keeping `character_location` as history while a character
  is boarded would give the memory routes, not just docks. That is its own
  project, with its own write-load cost.
