# EDENCOM Link — Industry Skill

This document tells an AI agent how EVE Online industry works, and how to use
the tools of this MCP server. Read it once at the start of a session. The
`get_skill` tool returns this text.

## What this server is

EDENCOM Link extracts EVE Online data and saves it in a database. The tools of
this server read that database. The tools never call ESI.

Extract jobs read the EVE ESI endpoints for each registered character and
corporation: assets, blueprints, industry jobs, orders, wallets, skills,
clones, fittings, contracts, structures, mercenary dens. The per-character
jobs run every 6 hours, each character at its own moment of the hour. The
corporation jobs for assets, blueprints and structures run once a day. A job
reads the public contracts of every region every 15 minutes. A nightly job
mirrors the EVE Static Data Export (SDE): item types, blueprints, solar
systems, planets, stargates.

Each tool result carries `data_refreshed` timestamps. If a timestamp is old,
tell the user. The user can refresh a character or a job on the
`/account/registrations` page of the site. A job that completed in the last 5
minutes does not run again.

Row-level security scopes every read to the caller's own characters and
corporations, and to what other players shared with the caller (see "What the
caller can see of shared things"). A tool cannot read another user's data in
any other way.

## Corporation data needs in-game roles

A corporation extract needs two things from one registered character: the ESI
scope on its token, and an in-game role in the corporation.

| Data                                            | Role in the game                |
| :---------------------------------------------- | :------------------------------ |
| Structures (`list_structures`)                  | Station Manager or Director     |
| Wallet divisions and journal (`wallet_summary`) | Accountant or Junior Accountant |
| Corporation assets and blueprints               | Director                        |
| Corporation industry jobs                       | Factory Manager                 |

If one kind of data is missing for one corporation, the usual cause is a
missing role: no registered character in that corporation holds it. The
extract records this as a skip, not as a failure, and does not ask the same
character again for 7 days. Tell the user which role is necessary. Do not
report it as a fault of the server.

## Past moments (`as_of`)

Some tables keep full history (SCD-2). Five tools take an `as_of` parameter
and show the data as it stood at a past moment: `search_assets`,
`list_assets`, `browse_assets`, `list_industry_jobs` and `list_market_orders`.
The value is a UTC moment in ISO 8601. Partial dates are permitted, for
example `2026-06` or `2026-06-01`.

- History is only as fine as the extracts. A character's hangar has a
  snapshot every 6 hours, a corporation's hangar one each day. A change
  between two snapshots shows at the next snapshot.
- A ship that was sold or lost after the moment comes back in the result. Use
  this for "where was my Avatar last Tuesday" or "what was in that ship".
- `appraise_items` and `appraise_assets` price at today's market only. To
  value a past hangar, list it with `as_of`, then appraise the names, and say
  that the prices are today's.
- `include_shared` reads the shares as they are now. You cannot combine it
  with `as_of`.

## Blueprints

A blueprint original (BPO) has unlimited runs. A blueprint copy (BPC) has a
fixed number of runs, and is consumed. ESI encodes this in one field:
`runs = -1` means BPO, any other value is the runs that remain on a BPC.

Two more ESI sentinels: `quantity = -1` means a singleton (unstacked) item,
and `quantity = -2` means a BPC stack. Do not sum raw quantities. Count rows,
or apply the sentinel values first.

A blueprint has two research levels:

- Material efficiency (ME), 0 to 10. Level N multiplies each material
  quantity by `(1 - N/100)`.
- Time efficiency (TE), 0 to 20. Level N multiplies the job time by
  `(1 - N/100)`.

Research jobs raise one level at a time, in a research slot. Each level costs
more time than the one before it. Reaction formulas cannot be researched.
They always report ME/TE 0/0, so exclude them from research-backlog answers
(`list_blueprints` has a `researchable` parameter for this).

Industry activity ids: 1 Manufacturing, 3 TE Research, 4 ME Research,
5 Copying, 7 Reverse Engineering, 8 Invention, 9/11 Reactions.

## Material mathematics

The `eve-industry` package computes the materials a job consumes. The
blueprint tools (`blueprint_for_product`, `blueprints_using_material`) apply
it when you give them modifiers. For each material:

```
need = max(runs, ceil(round2(runs × base × (1 − ME) × (1 − structure) × (1 − rig × sec))))
```

The order of operations is part of the game rules. First multiply all
modifiers. Then round the product to 2 decimal places. Then take the ceiling.
Then apply the minimum of 1 unit for each run.

The four modifiers:

| Modifier    | Values         | Source                                         |
| :---------- | :------------- | :--------------------------------------------- |
| `ME`        | 0.00 to 0.10   | Blueprint ME level ÷ 100                       |
| `structure` | 0 or 0.01      | 1% when the job runs in an engineering complex |
| `rig`       | 0, 0.02, 0.024 | No rig, T1 rig, T2 rig                         |
| `sec`       | 1, 1.9, 2.1    | Highsec, lowsec, nullsec and wormhole          |

The security band comes from the displayed (rounded) security of the system:
0.5 and more is highsec, more than 0.0 is lowsec, all other space is nullsec.
Note that the security multiplier applies to the rig bonus only. A T2 rig in
nullsec gives `0.024 × 2.1` = 5.04% material reduction.

The per-run minimum has a consequence: a material with a base quantity of 1
never decreases. Bonuses only help materials with larger base quantities.

## Rig bonuses

A material rig does not discount every job in its structure. Each rig carries
a filter, and the filter lists the product groups and categories the rig
covers. A rig applies to a job only when the product of that job is in the
filter. Example: a Standup M-Set Ship Manufacturing rig does not discount a
component build in the same structure.

When more than one fitted rig covers a product, the strongest one counts. The
tiers come from the rig name: the "... II" variant is T2 (0.024), the "... I"
variant is T1 (0.02). The `rigs_for_blueprint` tool lists the rigs that cover
a given product.

The name of a material rig does not always say "Material Efficiency". The
L-Set and XL-Set "Efficiency" rigs reduce materials too: for example,
"Standup L-Set Reactor Efficiency II" covers reactions. The tools identify a
material rig from its modifiers, not from its name. Do not ignore a rig in a
`list_structures` result because of its name.

The blueprint tools accept the modifiers in two forms. You can give
`structure`, `rig`, and `security` by hand. Or you can give `structure_id`
for one of the user's monitored structures, and the tool derives the hull
role bonus, the strongest applicable fitted rig, and the system security for
you. Prefer `structure_id` when the user names where they build. A structure
that another corporation shares with the user works as `structure_id` too.

## Invention

Tech 2 blueprints are not sold and do not drop. To build a T2 item, you make
a T2 BPC with invention:

1. Copy the T1 BPO into a T1 BPC (activity 5, a research slot).
2. Run an invention job on the T1 BPC (activity 8, also a research slot).
   Each attempt consumes one run of the BPC and two types of datacores. A
   decryptor is optional, and is consumed.
3. Each attempt succeeds with a probability. Success gives a T2 BPC at ME 2,
   TE 4, with a base run count — usually 1 for ships and rigs, 10 for modules
   and ammunition. A decryptor changes the probability, the run count, the
   ME, and the TE.

The probability is:

```
P = base × (1 + encryption_skill/40 + (science_skill_1 + science_skill_2)/30) × decryptor
```

The base chance depends on the product class, from about 18% (battleships) to
34% (modules and ammunition). Tech 3 invention works the same way, but runs
from ancient relics instead of BPCs.

The job installation fee scales with the system invention cost index
(`industry_cost_indices`). Invention, copying, and research jobs all occupy
research slots (`list_job_slots`). The SDE blueprint view of this server
covers manufacturing and reactions only, so `blueprint_for_product` does not
return invention bills of materials.

## Compressed and uncompressed inputs

A bill of materials names the form a job consumes, and that form is never
the compressed one. A manufacturing bill names minerals, not ore. A reaction
bill names fullerites and moon materials, not their compressed forms.
`Compressed Fullerite-C50` is the same gas packed for hauling, at a tenth of
the volume (0.1 m³ against 1 m³). No blueprint consumes it, and decompressing
it gives back 95% of the units (see "Buying gas for C-J6MT").

So when a user asks "do I need compressed or uncompressed X for this job",
call `blueprint_for_product` and read the names in the bill. The name in the
bill is the exact type the job takes. `blueprints_using_material` on the
compressed name returns no blueprints, which is the same answer. The
compressed form is for freight: `shipping_quote` with an `items` manifest
takes volume from the names you give it, so name the compressed form when the
question is about moving the material, and the uncompressed form when the
question is about reacting or building with it.

## Buying gas for C-J6MT

When the user gives a list of Fullerite, Mykoserocin or Cytoserocin gases and
asks where to buy them for the best price, find the cheapest way to have each
gas in C-J6MT, ready to react. There are four sources for each gas:

| Source                          | Units to buy for N usable | Cost per usable unit             |
| :------------------------------ | :------------------------ | :------------------------------- |
| Raw gas in C-J6MT               | N                         | `C-J6 sell`                      |
| Compressed gas in C-J6MT        | N ÷ 0.95                  | `C-J6 sell ÷ 0.95`               |
| Raw gas in Jita, shipped        | N                         | `Jita sell + rate × m³`          |
| Compressed gas in Jita, shipped | N ÷ 0.95                  | `(Jita sell + rate × m³) ÷ 0.95` |

- Decompression gives back 95% of the units. Buy N ÷ 0.95 compressed units,
  rounded up, to have N usable units. Only the compressed sources lose units.
- The compressed name is "Compressed " and the gas name, for example
  `Compressed Amber Mykoserocin`. It has a tenth of the volume of the raw gas,
  so it costs a tenth to ship. Do not use volumes from memory: take
  `volume_m3` from `appraise_items`, because the gases differ (a Fullerite is
  1 to 10 m³ a unit, a Mykoserocin or Cytoserocin 10 m³).
- `rate × m³` is the freight for one unit. Get the rate from `shipping_quote`
  with no arguments: it lists the Jita → C-J6MT lane and its tiers.

The procedure:

1. Call `appraise_items` twice, with `market` `jita` and with `market`
   `cj6mt`. In each call, put every gas in raw and compressed form.
2. Use `sell_price`: it is what the user pays to buy now. A `sell_price` of 0
   or null means that nobody sells the item in that market. That source is
   not available. It is not free.
3. For each gas, compute the cost per usable unit of the four sources and
   pick the cheapest. The price gap between the raw and compressed forms
   changes from gas to gas, so compressed is not always cheaper.
4. Add up the volume and the Jita sell value of everything bought in Jita.
   Call `shipping_quote` with origin `Jita`, destination `C-J6MT`,
   `volume_m3` and `collateral_isk` for that one haul.
5. Freight is billed per haul, by tier, and a tier can change the answer. At
   this time the smallest tier on this lane, up to 4,000 m³, costs nothing,
   and a larger load costs 700 ISK for each m³ of the whole load. If
   compressing a gas you planned to ship raw puts the haul under a cheaper
   tier, compare the two plans with a quote for each. Rates change, so quote;
   do not assume these figures.

Give the answer as a table: for each gas, the source, the form, the units to
buy, the cost per usable unit and the total. Then give the haul: its volume,
the freight, and the reward and collateral to set on the courier contract.
If the spread between buy and sell is wide, say that a buy order at
`buy_price` can cost less, if the user can wait for it to fill.

## Capital hulls have no market price

Supercarriers and titans are not sold on the market. They change hands by
contract, usually inside an alliance, at prices nobody publishes. The
appraisal service therefore answers zero, or a number that is wrong by a
factor of a thousand, for a Nyx or a Ragnarok.

This deployment keeps a table of hull prices that a Chancellor sets by hand:
one price per supercarrier and titan hull. As starting points, a Tech 1
supercarrier is about 42 billion ISK and a Tech 1 titan about 128 billion.
The prices float. `appraise_items` and `appraise_assets` substitute the set
price for such a hull, as both sell and buy, and list the hulls they did
this for under `hull_priced`. A hull with no set price is unpriced; say so.
Do not quote the market number for it.

## Job installation cost

The game bills a job when it is installed:

```
cost = EIV × (system cost index × hull multiplier + facility tax + 0.04 + alpha surcharge)
```

- EIV, the estimated item value, is the job's material bill at ME 0, priced
  at CCP's adjusted prices (ESI `/markets/prices/`, not market prices), times
  the runs. This is the base every fee scales from.
- The system cost index comes from `industry_cost_indices`. It is per system
  and per activity, and it moves with the activity in the system.
- The hull multiplier is the job-cost reduction of the engineering complex
  the job runs in: Raitaru 0.97, Azbel 0.96, Sotiyo 0.95. It applies to the
  index term only. Citadels and refineries give none (1).
- The facility tax is the rate the structure's owner sets. ESI publishes it
  nowhere.
- 0.04 is the SCC surcharge, 4% of EIV, paid to nobody.
- The alpha surcharge is 0.0025 when an alpha clone installs the job, and 0
  for an omega clone.

Research, copy and invention jobs bill on a different base: the product's
value at a 2% job-cost multiplier. Reaction jobs bill like manufacturing.

The facility tax of a rented structure is not secret. A job's `cost` (in
`list_industry_jobs`) contains it, and every other term is known, so:

```
facility tax rate = cost / EIV − cost index at install × hull multiplier − 0.04
```

This holds for manufacturing and reaction jobs only. The tools do not give
adjusted prices or past cost indices, so do not try to compute it yourself.
The `/structure` page of the site does it: each structure where the user
rents shows "Taxes Paid (est.)" and the recovered rate.

## Job profit (lift)

The `/industry` page of the site charts the "lift" of the user's jobs. Use the
same definition when the user asks whether a job makes money:

```
lift = value of the product − value of the materials consumed − installation cost
```

- Value is the Jita split: the midpoint of the best buy order and the best
  sell order. If only one side has orders, use that side.
- The materials are what the job really consumed: the ME 0 bill, with the
  blueprint's own ME and the per-run minimum applied (see "Material
  mathematics"). The site applies no structure or rig bonus, because the
  extract does not record which rig applied.
- Divide the lift by the job's duration to get ISK per hour. The site adds the
  rates of all the jobs that run at one moment.
- Lift is for manufacturing and reactions only. Research, copying and
  invention make nothing with a market price. A cancelled or reverted job
  made nothing.

The site prices everything at the hour the job was installed. The tools price
at today's market only. To estimate with the tools: `list_industry_jobs`
gives the product, the runs and the `cost`; `blueprint_for_product` with the
blueprint's ME gives the bill; `appraise_items` gives `buy_price` and
`sell_price` for each line, and their midpoint is the split. Say that the
prices are today's.

## The corporation wallet journal

`wallet_summary` groups the corporation journal by entry type. Read the
`industry_job_tax` total with care, because its sign does not tell you whose
job it was:

- A positive entry: someone paid facility tax into one of the corporation's
  structures. This is revenue.
- A negative entry at a structure the same corporation owns: the corporation
  installed a job as the corporation, in its own structure. The game writes
  only this outgoing side, and no receipt for it appears in any journal. It
  is not rent paid to someone else.
- A negative entry at another owner's structure: the corporation paid the
  facility tax to a landlord.

So a corporation that runs its jobs as the corporation in its own structures
can show a negative `industry_job_tax` total. Do not report that as ISK lost
to other players. The `/structure/revenue` page of the site separates the
three cases.

## Reading asset rows

- An `Office` item is a corporation's office in a station or structure. The
  corporation hangar items sit inside it.
- The flags `CorpSAG1` to `CorpSAG7` are the seven corporation hangar
  divisions. The corporation names them in the game, but ESI does not give
  those names, so refer to them by number.
- An item with the flag `AssetSafety`, or inside an `Asset Safety Wrap`, is
  in asset safety: the game moved it out of a player structure. The player
  can deliver it to an NPC station in the game.

## Saved fittings

- A character can save 500 fittings in the game. ESI shows only personal
  fittings. Corporation and alliance fitting folders are not available.
- The game gives a fit a new `fitting_id` each time the fit is saved. Do not
  use a `fitting_id` to identify a fit over time.
- The user can marshal a fit: the site keeps the fit in the account's archive
  and deletes it from the game, which frees a slot. Later the user can
  unmarshal it onto any of their characters. The user can also transfer a
  fit from one character to another.
- `list_fittings` with `include_marshalled` lists the archive as a separate
  `marshalled` array. Each archived fit has a `content_hash`, which is its
  identity. Its page is `/fitting/marshalled/<content_hash>`.
- The tools cannot marshal, unmarshal, transfer or delete a fit. These change
  the game, so the user does them on the fit's page on the site, or with the
  macOS mount.

## Upgrading a ship's fit

When the user asks for upgrades to a fit, examine every module on it. Find
variants with a higher meta level that the user can get at a good price: on
the market, on a contract, or by building them from a BPC.

1. Get the modules. For a saved fit, call `list_fittings` with
   `include_items`. For a ship in a hangar, find it with `search_assets`,
   then call `browse_assets` with its id to list what is fitted.
2. Find the variants of each module with `module_variants`. A variant does
   the same work at a different meta level: named Tech I (Compact, Enduring
   and others), Tech II, Storyline, Faction, Deadspace, Officer. The tool
   lists the whole family from static data, each with its meta level and
   tier, and marks the variants above the fitted module `higher_meta`. Those
   are the upgrade candidates. It also names the blueprint that builds a
   variant, where one exists. Do not suggest Abyssal modules: their
   attributes are different for each item, and a contract does not show
   them.
3. Set the price limit. A good price is a percentage below what the item sold
   for in the last 90 days. If the user does not give the percentage, use 10%
   and say so. The tools do not hold 90 days of sales yet, so use the best
   reference available, and name it in the answer:
   - For an item that trades on the market: the Jita split (the midpoint of
     `buy_price` and `sell_price` from `appraise_items`).
   - For an item that trades by contract: the closed contracts for it
     (`search_public_contracts` with `status` `closed` and
     `issued_within_days` 90). This history starts on 2026-10-09, and a
     closed contract can be withdrawn and not sold, so it is weak evidence.
4. Find the offers:
   - Market: `sell_price` from `appraise_items`, in `jita` and in the user's
     home market (`cj6mt` for C-J6MT).
   - Contracts: `search_public_contracts` with the module as `item`,
     `contract_type` `item_exchange` and `sort` `price_asc`. A contract with
     more than one item asks one price for all of them. Compare its price
     only when the module is its only item, or when you also value the other
     items. Name the system of each contract, because a far contract also
     costs freight.
   - BPCs: `search_public_contracts` with the `blueprint` name from
     `module_variants` as `item`. A blueprint line shows its runs, ME and TE. You often must buy a BPC and
     build the module: Tech II BPCs come from invention, and many Faction
     BPCs come from loyalty point stores.
5. Value each BPC as what it makes, less what it consumes:

   ```
   BPC value = runs × (value of the product − value of the inputs for one run)
   ```

   Get the inputs from `blueprint_for_product`, and price the product and the
   inputs with `appraise_items`. The short method: use the ME 0 bill and
   ignore the job fee. The ME saving and the job fee are usually of about the
   same size, so they cancel. The full method: give `blueprint_for_product`
   the BPC's ME and the best structure the user builds in (`structure_id`),
   or an ideal one (`structure` `engineering_complex`, `rig` `t2`, with the
   user's `security`). Then subtract the job fee, about
   `EIV × (cost index + facility tax + 0.04)` (see "Job installation cost").
   A cost index of 4% is typical. For a closer figure, use the manufacturing
   index from `industry_cost_indices` for the systems where the user's recent
   jobs ran (`list_industry_jobs` with `status` `all`). A BPC is a good buy
   when its price is below its value by the same percentage.

6. The tools cannot check whether a module fits. A higher meta level can need
   more CPU or powergrid, or skills the pilot does not have. Tell the user to
   check the fit in the game, or on the ship's page on the site, which uses
   the pilot's own skills.

For each module, give the best upgrade found: the item, where to get it
(market, a contract and its system, or a BPC to build), its price, the
reference price, and the percentage below the reference. Leave out the
modules that have no upgrade at a good price.

## Public contracts

`search_public_contracts` searches every public contract that ESI listed in
any region since 2026-10-09, open and closed. It is not limited to the user's
data: the issuers are any players. Name at least one of `item`, `region`,
`system` or `issuer`.

The statuses:

- `outstanding`: the contract is listed now. This is the default.
- `expired`: the contract left the listing at or after its expiry.
- `gone`: the contract left the listing before its expiry. It was accepted or
  withdrawn, and ESI does not tell which.
- `closed` asks for `expired` and `gone` together. `any` asks for all.

Do not say that a `gone` contract sold. Say that it was accepted or
withdrawn. An acceptance close to the expiry can show as `expired`.

Read the results with these rules:

- `item` matches contracts that offer the item. An item that a contract asks
  for does not match; where it appears, it has `requested: true`.
- The item name is a fuzzy search: "Raven" also matches "Raven Navy Issue"
  and "Raven Blueprint". Check the type names in the result.
- `price` is what the acceptor pays. On an auction it is the starting bid,
  not the winning bid; the server does not read bids. `reward` and
  `collateral` belong to couriers. A courier has no items, and a price filter
  excludes couriers.
- A blueprint line says copy or original, with ME and TE. It shows runs on a
  copy only.
- `issuer` takes an exact name or an EVE id. It matches the issuing character
  or the issuing corporation, so a corporation name also matches the personal
  contracts of its members.
- `total` counts every match. Only the first `limit` contracts are listed
  (default 50, maximum 200).

Known gaps, to state when they matter:

- ESI lists at most 35 pages of contracts for The Forge. When The Forge is
  full, its newest contracts appear only after older ones close. Recent
  results for The Forge can be incomplete.
- The server reads the items of 1000 contracts in each run, newest first. A
  new contract can show "Items not fetched yet".
- A contract in a player structure whose system the server does not know
  does not match a `system` filter.
- There is no history before 2026-10-09.

## The user's own contracts

No fixed tool lists the user's own contracts. Use `run_query` with the
GraphQL `contracts` field (call `link_schema` first).

- `direction` says `bought`, `sold` or `neither` from the user's side. Only
  an item exchange or an auction can be `bought` or `sold`. A courier is
  `neither`, even when the user paid the reward.
- `status` is ESI's word for the current state: `outstanding`,
  `in_progress`, `finished`, `finished_issuer`, `finished_contractor`,
  `cancelled`, `rejected`, `failed`, `deleted`, `reversed`. The `status`
  argument is a search, so `finished` matches all three finished states. The
  `statuses` argument is an exact list.
- ESI shows a completed contract for 30 days. The server keeps it after that,
  with its last status.
- The `direction` filter applies after the row `limit`. It can return fewer
  rows than exist, so give a larger `limit` when you filter on `direction`.

## Mercenary dens and planets

- `list_mercenary_dens` lists the dens of the user's characters: state,
  development and anarchy levels, infomorphs and the reinforcement timer.
  Reinforced dens come first, the soonest timer first. Dens that alliance
  members share with the user also appear, with `shared: true`. The state is
  from the last extract (`status_observed_at`), not live.
- `list_planets` reads static data only. Use exactly one of its three modes:
  - `planet_ids` turns raw planet ids into names, such as "Q-UVY6 II".
  - `system` lists the planets of one system and the count of each type.
  - `region`, with an optional `planet_type`, lists the systems that have a
    planet type: temperate planets for a mercenary den, lava planets for
    planetary industry.
- A planet name is "<system> <Roman numeral>". The SDE stores no planet names.

## Spreadsheets

A Google Sheet reads this deployment's price data without any script:

- `/sheets/market/<market>/price_data?type_id=1,2,3` answers `=IMPORTXML` in
  blocks of type ids, in the same XML shape as the goonmetrics `price_data`
  API (`//price_data/type`), from the hourly market capture.
- `/sheets/market/<market>` is the whole market as CSV, for `=IMPORTDATA`.
- `/sheets/adjusted-prices` is CCP's adjusted price for every type as CSV,
  the EIV base above, captured daily.

Tell a user with an Apps Script that calls ESI to read these instead. Apps
Script fetches from a shared Google IP pool, where every other script's ESI
traffic counts against the same limit, so its ESI calls fail with error 420
for reasons the sheet cannot control.

## What the caller can see of shared things

Other players, and corporations, can share things with the caller. The tools
see them only in these ways:

- Items. `search_assets` and `list_assets` return shared items only with
  `include_shared`. Each shared row has `shared: true` and names the owner
  who shared it. An item share never says where the item is: its system and
  station are null, so a `system` filter drops it. A share of a whole
  station, structure or system names that place, and covers only the sharer's
  own items there.
- `browse_assets` and `appraise_assets` reach a shared ship or container by
  its raw id, and value or list everything inside it. At a place that someone
  shared with the caller, they list or price the sharer's items there
  together with the caller's own. `owner` tells them apart.
- A corporation item share stops working when the member who made it leaves
  the corporation. Another member can save it again to restore it.
- Structures. `list_structures` also returns structures that other
  corporations share with the caller, marked `shared: true`. A shared
  structure shows its services and rigs but never its fuel. Its
  `structure_id` works in the blueprint tools. With no system named,
  `industry_cost_indices` includes the systems of shared structures too.
- Industry jobs. A player who ran a job at a structure in the last 30 days
  can see the current jobs of the other tenants there on the site.
  `list_industry_jobs` never lists them; it lists only the user's own jobs.
- Fittings. `list_fittings` includes fits that other players share with the
  caller. The marshalled archive is the account's own, and is never shared.
- A Data Link shared with the caller runs under its creator's data. The
  caller sees the results, never the underlying rows.
- A ship share link (`/ship/<id>?share=…`) keeps working after the ship
  leaves the owner's hangar. The page then shows the ship as it was last
  seen, with the time of that sighting, and marks a sighting older than one
  day.

## Tools that write

Three tools change data. Each changes only the user's own rows on this site,
and none changes the game:

- `create_link` saves a Data Link, and can share it.
- `update_link` changes a Data Link. Its audience sees the change the next
  time they open it.
- `edit_watched_systems` changes the list of systems on the `/indexes` page,
  which is what `industry_cost_indices` reports with no system named. Its
  commands: `SELECT` reads the list, `INSERT` adds a system at an index,
  `UPDATE` moves a system to an index, and `DELETE` removes it. The index is
  where the system is after the change, counted from 0. Removing a system
  does not stop its cost-index history.

Confirm a change with the user before you call a tool that writes.

## Which tool answers which question

- Item by name, anywhere: `search_assets`. By type/location/owner id:
  `list_assets`. By place: `browse_assets`. Add `include_shared` for what
  others shared, or `as_of` for a past moment.
- Blueprints, with ME/TE filters and grouping: `list_blueprints`.
- Bill of materials, with bonuses applied: `blueprint_for_product`. What
  consumes an input: `blueprints_using_material`. Which rigs cover a product:
  `rigs_for_blueprint`.
- What builds now, and when it ends: `list_industry_jobs` (has `as_of`).
  Who can start a job: `list_job_slots`. Cost indices:
  `industry_cost_indices`; its default systems: `edit_watched_systems`.
- ISK value of items or a hangar: `appraise_items`, `appraise_assets`
  (set hull prices applied, see above). Freight cost on the alliance lanes:
  `shipping_quote`.
- Balances: `wallet_summary`. Trades: `search_transactions`. Open orders:
  `list_market_orders`. The user's own contracts: `run_query` on `contracts`.
  Anyone's public contracts: `search_public_contracts`.
- Characters, ships, clones: `list_clones`. Saved fits and the archive:
  `list_fittings`. Structures: `list_structures`.
- Mercenary dens: `list_mercenary_dens`. Planets and planet types:
  `list_planets`.
- Where to buy reaction gas for C-J6MT: `appraise_items` in `jita` and
  `cj6mt`, then `shipping_quote` (see "Buying gas for C-J6MT").
- The variants of a module and their meta levels: `module_variants`.
- Upgrades for a fit: `list_fittings`, `module_variants`, `appraise_items`,
  `search_public_contracts` and `blueprint_for_product` (see "Upgrading a
  ship's fit").
- This manual: `get_skill`.

If no fixed tool answers the question, use the GraphQL surface below.

## The GraphQL surface

The same data is exposed as one GraphQL schema. Three steps:

1. Call `link_schema`. It returns the schema, the rules, worked examples, and
   the audiences the user can share with. Do not write a query from memory.
2. Call `run_query` with the query and its variables. Nothing is saved. Use
   this for one-off questions, and to test a query.
3. If the answer is worth keeping, pass the same query to `create_link`. A
   Data Link is a saved query. The user can open it as a page or a CSV, and
   can share it with a corporation, an alliance, or a signed URL.
   `list_links` and `update_link` manage the saved ones.

The rules, in short: one query operation, one top-level field, no
session-only surfaces. All ids in the schema are strings, because EVE ids
overflow a 32-bit Int. Rows are flat, so each row becomes one CSV line.

A shared Data Link runs under its creator's context. The audience sees the
results. The audience does not gain access to the data itself, and cannot
change the query or its variables.

## What only the site does

Some work has no tool. Send the user to the page:

- Refresh an extract: `/account/registrations`.
- Share an item, a place, a structure, a fit or a blueprint library: the
  Share button on its page.
- Marshal, unmarshal, transfer or delete a fit: the fit's page under
  `/fitting`.
- Hide one job from the other tenants of a structure: the job's menu on
  `/industry`.
- Facility tax revenue, cost avoidance, and the estimated tax rates of rented
  structures: `/structure` and `/structure/revenue`.
- Lift rate of all jobs over time: `/industry`.
- Delete a Data Link: `/link`.
