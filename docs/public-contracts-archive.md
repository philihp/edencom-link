# Public contracts from the EVE Ref archive

A daily job, `public-contracts-archive`, that loads
`https://data.everef.net/public-contracts/public-contracts-latest.v2.tar.bz2`
into the `public_contract*` tables, plus an MCP tool, `search_public_contracts`,
that answers questions over them. Status: 📋 planned. Nothing is built yet.

This doc is the plan. It records what is in the archive (measured on
2026-10-11), how it relates to the `public-contracts` extract that already
runs every 15 minutes ([public-contracts.md](public-contracts.md)), what gets
written where, and the order to build it in.

## Why a second source

The ESI extract already stores every public contract it can list, and its
items. The archive adds four things the extract cannot get, or gets slowly:

| What the archive has | The ESI extract today |
| :-- | :-- |
| **Auction bids** (`contract_bids.csv`) | Not pulled. Listed under "Not done yet" |
| **Dynamic (Abyssal) items**: mutator, source type, and every dogma attribute and effect of each mutated module on contract | Not pulled. Abyssal modules on contract show as the bare type id of a mutated item |
| **`system_id`, `constellation_id`, `station_id`** resolved for every contract | Only `start_location_id`, which is a station or a structure id |
| **Every contract's items in one file** | One ESI request per contract, 1000 a run, so a fresh deployment takes half a day to catch up and an active day is a constant backlog |

The archive is also a different reading of The Forge. On 2026-10-11 the
archive's Forge listing held 34,323 contracts and its newest contract id was
the newest in New Eden. Our ESI listing two days earlier was cut off at 35,000
with its newest contract 44 to 69 minutes behind. Whether the archive sees past
the cap is to be checked on the first import: count the contracts the archive
inserts that the extract had never seen.

## The source

EVE Ref scrapes ESI twice an hour (00 and 30 past) and publishes one archive,
documented at
[docs.everef.net/datasets/public-contracts](https://docs.everef.net/datasets/public-contracts.html).
A history of every snapshot since 2019 sits under `/public-contracts/history/`.
We take only `latest`, once a day, as asked. A finer cadence is a one-line
change to `vercel.json`, but the ESI extract already covers the 15-minute
picture, and the things only the archive has (bids, Abyssal dogma) do not
move by the minute.

Measured on 2026-10-11 19:01 UTC:

| File | Rows | Bytes |
| :-- | --: | --: |
| `public-contracts-latest.v2.tar.bz2` | | 6,607,419 |
| `meta.json` (`scrape_start`, `scrape_end`, `datasource`) | 1 | 102 |
| `contracts.csv` | 50,735 | 10,089,320 |
| `contract_items.csv` | 381,678 | 29,837,275 |
| `contract_bids.csv` | 1,326 | 94,858 |
| `contract_dynamic_items.csv` | 13,145 | 899,133 |
| `contract_dynamic_items_dogma_attributes.csv` | 324,307 | 18,649,542 |
| `contract_dynamic_items_dogma_effects.csv` | 49,280 | 2,732,854 |
| Uncompressed total | | 62,309,376 |

Of the 50,735 contracts, 49,971 have item rows. Item exchanges and auctions
number about 49,073, couriers about 760. So the archive itemises essentially
every contract that can be itemised. `title` is free text with embedded
commas and quotes (2,001 quoted lines), so the reader must be a real RFC 4180
parser, not a split on commas.

The response carries `ETag`, `Last-Modified` and `Accept-Ranges: bytes`, and
is served from Cloudflare with a two-minute cache.

### Decoding it on Vercel

Node has no bzip2. Two pure-JS decoders were timed on this archive on an M-series
Mac:

| Decoder | 62.3 MB out | Peak RSS |
| :-- | --: | --: |
| `unbzip2-stream` (streaming) | 1.47 s | 164 MB |
| `seek-bzip` (whole buffer) | 1.27 s | 345 MB |

Both are far inside a 60-second workflow step. **Use `unbzip2-stream`**: it
streams, so the 62 MB never has to exist at once, and the memory cost stays at
the decoder's working set. It is one new dependency. The tar container needs
none: ustar is 512-byte headers (name at 0–100, size as octal at 124–136, type
flag at 156) followed by the content padded to 512, which is a 30-line pure
reader we can test, cheaper than `tar-stream` and its dependency tree.

The job is therefore download → decode → untar → parse CSV, as one pipeline
in memory, and only the writes take real time.

## Where it writes

**Decision: feed the existing `public_contract*` tables, not a parallel copy.**
A contract's facts are frozen at issue, and both sources read the same ESI
routes, so a `public_contract` row is the same row whichever source wrote it
first. Keeping two copies of 50,000 contracts and 380,000 item lines would
double the storage for no second fact. The archive-only data (bids, dynamic
items, resolved places) lands in new tables and new columns keyed to
`public_contract`.

### Existing tables

- **`public_contract`**: `upsert … ignoreDuplicates` (insert, `on conflict do
  nothing`). The archive never overwrites a row the extract wrote. For a row
  the archive writes first, `first_seen_at` is the snapshot's `scrape_end`.
  Three new nullable columns, written by both sources: `system_id`,
  `constellation_id`, `station_id` (null for a structure). The archive has them
  on every row. The extract can fill `system_id` from `sde_station` for a
  station id and from `universe_structure` for a structure it knows; that is a
  small follow-up in `publicContractFields.js`, not part of this plan's first
  PR.
- **`public_contract_item`**: `upsert … ignoreDuplicates` on `(contract_id,
  record_id)`. Then set `items_fetched_at = scrape_end`, `items_status = 200`
  on every contract whose items the archive supplied and whose
  `items_fetched_at` is null. **This is the archive paying the extract's item
  backlog**: after the daily import, `public_contract_items_owed()` returns only
  contracts issued since the snapshot, and the extract's 1000-a-run ESI item
  pulls go to those. A contract that both sources itemise ends up with one set
  of rows, since `record_id` is ESI's and the same in both.
- **`public_contract_status_over_time`: the archive never writes it.** This is
  the one hard rule. The status model infers closure from a contract missing
  from a complete ESI listing of its region. If the archive opened a status
  for a Forge contract that the capped ESI listing cannot show yet, the next
  sweep would close it as `gone` within 15 minutes, and the record would say
  the contract was accepted when nobody touched it. So a contract the archive
  introduces sits with facts and items but no status until the ESI listing
  holds it, at which point the sweep returns it among the "listed, no status
  yet" ids and `public_contract_open()` gives it `outstanding`, exactly as it
  does for a contract the extract found itself. Readers must therefore not
  treat "no status" as "closed": see the `status` filter under the MCP tool.

### New tables

All four follow the `public_contract*` conventions: members read
(`authenticated`, `using (true)`), service role inserts and updates, no
`DELETE` grant, no cascades, RLS on.

```sql
-- One row per bid. Bids are frozen once placed; a contract's bids grow.
create table public.public_contract_bid (
  bid_id bigint primary key,
  contract_id bigint not null references public.public_contract (contract_id),
  amount numeric(20, 2) not null,
  date_bid timestamptz not null
);
create index public_contract_bid_contract_id_idx on public.public_contract_bid (contract_id);

-- One row per mutated item on a contract. An item id is unique in EVE and a
-- mutation is permanent, so the row is written once and never changes.
create table public.public_contract_dynamic_item (
  item_id bigint primary key,
  contract_id bigint not null references public.public_contract (contract_id),
  source_type_id bigint not null,   -- the module it was before mutation
  mutator_type_id bigint not null,  -- the mutaplasmid applied
  created_by bigint                 -- the character who rolled it
);
create index public_contract_dynamic_item_contract_id_idx on public.public_contract_dynamic_item (contract_id);
create index public_contract_dynamic_item_source_type_id_idx on public.public_contract_dynamic_item (source_type_id);

create table public.public_contract_dynamic_item_attribute (
  item_id bigint not null references public.public_contract_dynamic_item (item_id),
  attribute_id integer not null,
  value double precision not null,
  primary key (item_id, attribute_id)
);

create table public.public_contract_dynamic_item_effect (
  item_id bigint not null references public.public_contract_dynamic_item (item_id),
  effect_id integer not null,
  is_default boolean not null,
  primary key (item_id, effect_id)
);
```

The attribute table is the big one: 324,307 rows in one snapshot, about 25 per
mutated item. Because `item_id` is the primary key of the parent, the job
reads the set of `item_id`s it already holds and inserts attributes and effects
only for new items. The first run writes everything. A later run writes the
day's new mutated items, which is a few hundred, not 324,000.

### Import state

One row in `esi_etag`, cache key `everef:public-contracts`, holds the
archive's `ETag`. The job sends it as `If-None-Match` and a `304` ends the run
with nothing done, the same best-effort `getEsiEtag`/`putEsiEtag` pair the
conditional ESI jobs use, and it is stored only after the writes commit so a
failed run re-reads. The snapshot time is `meta.json`'s `scrape_end`, stamped
as `first_seen_at` and `items_fetched_at`. No new state table.

## The job

`src/jobs/publicContractsArchive.js`, exporting `runPublicContractsArchive()`,
CLI-runnable as `pnpm run public-contracts-archive`. Pure rules in
`src/jobs/publicContractsArchiveFields.js`, tested in
`test/publicContractsArchiveFields.test.ts`: the CSV parser, the tar reader,
the row mappers (CSV string → the typed row each table takes, with the same
"null, never 0, where the contract type has no such field" rule
`publicContractRow` applies today, and `""` for a missing boolean read as
null), and the "which items are new" split.

Order of work inside one run:

1. `GET` the archive with `If-None-Match`. `304` → return `{ unchanged: true }`.
   Any other non-200 → throw. Check `content-type` is bzip2 before decoding.
2. Pipe the body through `unbzip2-stream` and the tar reader, collecting the
   seven entries as text. Refuse an archive missing `meta.json` or
   `contracts.csv`, or whose `meta.datasource` is not `tranquility`.
3. Parse `contracts.csv`. Insert contracts in 500-row chunks, ignoring
   duplicates. Contracts first, because every other table references them.
4. Parse `contract_items.csv`. Insert items in 500-row chunks, ignoring
   duplicates. Then one `update public_contract set items_fetched_at,
   items_status = 200 where contract_id in (…) and items_fetched_at is null`,
   chunked at 500 ids.
5. Bids: insert, ignoring duplicates (`bid_id` is global).
6. Dynamic items: read existing `item_id`s (paged past 1000, the
   `fetchExisting` shape in `structureDirectory.js`); insert the new items,
   then only their attributes and effects.
7. Store the `ETag`. Log one line of counts per table: rows in the archive,
   rows inserted, rows already held.

Every write is an insert that ignores duplicates or an update guarded by
`is null`, so a run that dies anywhere is finished by the next, and a step
retry converges. The run order makes the foreign keys hold at every point.

Budget. The decode is under two seconds. The writes are the cost: the first
run is about 50k + 380k + 1k + 13k + 324k + 49k = 820k rows, 1,650 PostgREST
calls at 500 a chunk, which is minutes, not seconds. So the job cannot be one
60-second step. Two options, pick the first unless it proves too slow:

- **One workflow, one step per file.** Each step re-downloads and re-decodes
  the archive (two seconds, 6.6 MB from Cloudflare's cache) and writes one
  file's rows. The archive is re-read from the same URL, so a step must check
  the `ETag` it got against the one the first step recorded in the run and
  stop if EVE Ref published a new snapshot mid-run (the next day's run picks
  it up). This is the SDE mirror's shape, which re-inflates its zip entry per
  slice for the same reason. The items and attributes files are the two that
  may not fit a step on the first run; each step takes a start row and
  returns the row it stopped at (`STEP_BUDGET_MS`-style), and the workflow
  loops until the file is done.
- **Stage the decoded CSVs in a table** and have later steps read from it.
  Rejected for now: 62 MB a day written and deleted again, for a saving of
  two seconds a step.

A later run writes only what is new: a day of contracts (about 2,300 in The
Forge alone, per the extract's measurement), their items, and a few hundred
mutated items. One step per file will finish in one slice each.

Memory. The streaming decoder peaked at 164 MB holding every entry as text.
`recordPeakRss` already stamps every heartbeat-wrapped job, so the first
production run reports its own figure.

## Workflow, cron, registry

The usual single-job set, one file per piece, names all
`public-contracts-archive`:

- `src/workflows/publicContractsArchive.ts`: the per-file steps above, with
  the heartbeat pair opened by a plan step and closed by a finalize step (the
  `marketPrices.ts` shape, since `runJobWithHeartbeat` wraps one call and this
  is a fan-out). A `304` closes the heartbeat `ok` with nothing done.
- `src/app/api/cron/public-contracts-archive/route.ts`: `requireCronSecret`,
  then `start()`.
- `vercel.json`: `"schedule": "33 10 * * *"`. Daily, after the 09:47
  `structure-directory` run, so a structure the archive names as a
  `start_location_id` is already in `universe_structure`.
- `package.json`: `"public-contracts-archive": "node src/jobs/publicContractsArchive.js"`.
- `src/app/jobs/registry.ts`: a `universe` row, `kickable: 'chancellor'`, like
  `public-contracts`. `src/app/character/dispatchRefresh.ts`: the workflow
  loader, so the Chancellor cell on `/account/registrations` can start it.
- `.oxlintrc.json`/`next.config.mjs` need nothing: the job imports only from
  `src/`.
- `CLAUDE.md`: a line in Extract jobs beside `structure-directory`, and the
  new tables in the quick reference.

## Searchable through MCP

The archive makes the public-contract tables worth exposing: before it, every
query is "who sells X and where", and after it, also "what did this Abyssal
module roll" and "what are the bids on this auction". One tool, in a new
module `src/app/api/mcp/publicContractTools.ts`, registered in `route.ts`:

**`search_public_contracts`**, `readOnlyHint: true`, `openWorldHint: false`.
Inputs, all optional, AND-ed:

| Input | Resolves | Pushes down as |
| :-- | :-- | :-- |
| `item` | fuzzy type name → type ids (`resolveTypeFilter`, the `MAX_TYPES` guard) | `public_contract_item.type_id in (…)` and `is_included`; a mutated module matches on its `source_type_id` too |
| `contract_type` | `item_exchange` / `auction` / `courier` | `public_contract.type` |
| `region`, `system` | fuzzy names (`searchSdeRegions`, `searchSdeSystems`) | `region_id` / `system_id` |
| `issuer` | a character or corporation id, or a name through `character_directory` / `corporation` | `issuer_id` or `issuer_corporation_id` |
| `max_price`, `min_price` | | `price` |
| `status` | `open` (default), `closed`, `any` | see below |
| `contract_id` | one contract | everything about it: facts, items, bids, every dynamic item with its attributes named from `sde_dogmaAttributes` |
| `include_items` | | items on each row (default off, the `list_fittings` pattern) |
| `limit` | default `MAX_ROWS` (200) | |

`status` is the subtle one. `open` means *current status `outstanding`, or no
status row yet and `date_expired` is in the future*, so a contract the archive
introduced ahead of the ESI listing is found as open rather than hidden. `closed`
is `expired` or `gone`, with the closure window (`valid_until` of the previous
row to `valid_from` of the current) reported on each row, since that window is
the point of the status history. The tool says which rows have no status yet.

The query is one SECURITY INVOKER function, `public_contract_search(...)`, in
the shape of `blueprint_search()`: it joins contract, current status, items
and dynamic items, applies the filters, and returns `row_limit` rows plus a
total over the whole filtered set. In SQL rather than PostgREST filters because
the item filter is a join (`.in()` over a subselect is not expressible) and
the `open` predicate is an OR over two tables. Tested in
`test/sql/public_contract_search.sql` with the usual stand-in tables: the three
`status` modes, the no-status-yet case, the mutated-item match.

Rows resolve names the way every other tool does: type names from
`getSdeTypeNames`, system and region from the SDE loaders, station names from
`getSdeStationNames`, structure names from `universe_structure`, issuer names
from `character_directory`/`corporation` where known and the raw id otherwise.
`data_refreshed` reports both the `public-contracts` and
`public-contracts-archive` heartbeats, since a row may come from either.

Pure seam `publicContractQuery.ts`, tested: parsing the inputs into the RPC's
arguments, the `status` mode mapping, the issuer id-or-name split, formatting
a dogma attribute list against the base type's values so a roll reads as
"+12.4% damage, −3.1% rate of fire" rather than two columns of floats. (The
base values come from `sde_typeDogma` for the `source_type_id`; the
comparison is the whole reason to store the attributes.)

Add a section to `docs/edencom-industry-SKILL.md` naming the tool and what it
is for, since `get_skill` is how an agent learns the tools exist.

## Build order

Four PRs, each shippable alone:

1. **Schema**: the three columns on `public_contract`, the four new tables,
   their policies and grants. Migration via `pnpm run db:new` plus
   `schema.sql`. No code reads them yet.
2. **The job**: `publicContractsArchive.js` + fields module + tests, the
   `unbzip2-stream` dependency, package script. Verified by running it against
   production from the CLI once (it is idempotent, and the extract's tables
   are its tables). Record the first run's counts and peak RSS in this doc,
   and whether the archive inserted Forge contracts the extract did not hold.
3. **Schedule**: workflow, cron route, `vercel.json`, registry row, dispatch
   loader, CLAUDE.md lines.
4. **MCP**: `public_contract_search()` + SQL test, the tool module + pure
   seam + tests, the skill doc section, and the "Not done yet" lines in
   [public-contracts.md](public-contracts.md) updated.

## Not in this plan

- Loading the `/history/` snapshots to backfill closed contracts before the
  extract started. Possible with the same reader, one archive per step, but
  the status history would still begin at the extract's first listing.
- A page over public contracts. The MCP tool is the first reader; a page
  can follow once the queries people actually run are known.
- GraphQL fields for `run_query` and Links. The tables are members-only, so
  they fit the GraphQL surface; a follow-up once the search function exists.
- Making the ESI extract fill `system_id` for its own rows (noted above).

## Code (once built)

- `src/jobs/publicContractsArchive.js`, `src/jobs/publicContractsArchiveFields.js`,
  `test/publicContractsArchiveFields.test.ts`
- `src/workflows/publicContractsArchive.ts`,
  `src/app/api/cron/public-contracts-archive/route.ts`
- `src/app/api/mcp/publicContractTools.ts`, `src/app/api/mcp/publicContractQuery.ts`,
  `test/publicContractQuery.test.ts`
- `public_contract_search()`, `test/sql/public_contract_search.sql`
