# EDENCOM Link — Industry Skill

This document tells an AI agent how EVE Online industry works, and how to use
the tools of this MCP server. Read it once at the start of a session. The
`get_skill` tool returns this text.

## What this server is

EDENCOM Link extracts EVE Online data and saves it in a database. The tools of
this server read that database. The tools never call ESI.

Extract jobs read the EVE ESI endpoints for each registered character and
corporation: assets, blueprints, industry jobs, orders, wallets, skills,
clones, fittings, structures. The per-character jobs run every 6 hours, each
character at its own minute of the hour. The corporation jobs for assets,
blueprints and structures run once a day. A nightly job mirrors the EVE
Static Data Export (SDE): item types, blueprints, solar systems.

Each tool result carries `data_refreshed` timestamps. If a timestamp is old,
tell the user. Row-level security scopes every read to the caller's own
characters and corporations. A tool cannot read another user's data.

Some tables keep full history (SCD-2). Tools with an `as_of` parameter can
show the data as it stood at a past moment.

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

The blueprint tools accept the modifiers in two forms. You can give
`structure`, `rig`, and `security` by hand. Or you can give `structure_id`
for one of the user's monitored structures, and the tool derives the hull
role bonus, the strongest applicable fitted rig, and the system security for
you. Prefer `structure_id` when the user names where they build.

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
`Compressed Fullerite-C50` is the same gas packed for hauling, unit for unit
at a tenth of the volume (0.1 m³ against 1 m³), and no blueprint consumes it.

So when a user asks "do I need compressed or uncompressed X for this job",
call `blueprint_for_product` and read the names in the bill. The name in the
bill is the exact type the job takes. `blueprints_using_material` on the
compressed name returns no blueprints, which is the same answer. The
compressed form is for freight: `shipping_quote` with an `items` manifest
takes volume from the names you give it, so name the compressed form when the
question is about moving the material, and the uncompressed form when the
question is about reacting or building with it.

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
cost = EIV × (system cost index × hull bonus + facility tax + 0.04)
```

- EIV, the estimated item value, is the job's material bill at ME 0, priced
  at CCP's adjusted prices (ESI `/markets/prices/`, not market prices), times
  the runs. This is the base every fee scales from.
- The system cost index comes from `industry_cost_indices`. It is per system
  and per activity, and it moves with the activity in the system.
- The hull bonus is a job-cost reduction of the engineering complex the job
  runs in: Raitaru 3%, Azbel 4%, Sotiyo 5%. Citadels and refineries give none.
- The facility tax is the rate the structure's owner sets. ESI publishes it
  nowhere. At a rented structure, the tool data cannot tell you the rate; the
  user can read it in the game client when they install.
- 0.04 is the SCC surcharge, 4% of EIV, paid to nobody.

Research, copy and invention jobs bill on a different base: the product's
value at a 2% job-cost multiplier. Reaction jobs bill like manufacturing.

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

Another user can share things with the caller, and the tools see them only
in particular ways:

- A ship or container shared with the caller does not appear in "show me all
  my X" listings. It appears when addressed by its id (`browse_assets`,
  `appraise_assets` with a raw id) and in what its parent lists. Its
  location is always null to the caller: a share says what a thing is, never
  where it is.
- A fitting shared with the caller appears in `list_fittings`.
- A Data Link shared with the caller runs under its creator's data. The
  caller sees the results, never the underlying rows.
- A ship share link (`/ship/<id>?share=…`) keeps working after the ship
  leaves the owner's hangar. The page then shows the ship as it was last
  seen, with the time of that sighting, and marks a sighting older than one
  day.

## Which tool answers which question

- Item by name, anywhere: `search_assets`. By type/location/owner id:
  `list_assets`. By place: `browse_assets`.
- Blueprints, with ME/TE filters and grouping: `list_blueprints`.
- Bill of materials, with bonuses applied: `blueprint_for_product`. What
  consumes an input: `blueprints_using_material`.
- What builds now, and when it ends: `list_industry_jobs` (has `as_of`).
  Who can start a job: `list_job_slots`.
- ISK value of items or a hangar: `appraise_items`, `appraise_assets`
  (set hull prices applied, see above). Freight cost on the alliance lanes:
  `shipping_quote`.
- Balances: `wallet_summary`. Trades: `search_transactions`. Open orders:
  `list_market_orders`.
- Characters, ships, clones: `list_clones`. Saved fits: `list_fittings`.
  Structures: `list_structures`. Cost indices: `industry_cost_indices`.

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
