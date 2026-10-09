# Public contracts

The `public-contracts` extract keeps a copy of every outstanding public
contract in New Eden. It also keeps the contracts that closed in the last 30
days. The data is intel: who sells what, where it moves by courier, and what
leaves the market fast.

## What it reads

The extract uses three ESI routes. None of them needs a token.

| Route | Gives | ESI cache |
| :-- | :-- | --: |
| `/universe/regions/` | every region id (114 on 2026-10-09) | long |
| `/contracts/public/{region_id}/` | one page of a region's outstanding public contracts | 30 min |
| `/contracts/public/items/{contract_id}/` | the items of one item exchange or auction | 60 min |

The job runs every 15 minutes (`vercel.json`). It asks ESI about a region only
after ESI's cache of the last snapshot has expired, so most runs ask about few
regions or none.

## Where it writes

- **`public_contract`**: one row per contract, keyed on `contract_id`.
- **`public_contract_item`**: the items of a contract, deleted with it.
- **`public_contract_region`**: one row per region. It holds the snapshot time
  (ESI `Last-Modified`) last reconciled, when ESI's cache of it expires, the
  open count, and two flags described below.

Signed-in members can read all three tables. Anonymous visitors cannot. Only
the service role writes.

## How a contract closes

ESI lists only outstanding contracts. It does not list closed contracts, and
it does not say how a contract ended. The job therefore infers a closure:

1. It reads every page of a region.
2. It checks that the pages make one whole snapshot (see below).
3. It calls `public_contract_sweep()`. That function closes each open contract
   of the region that the listing does not hold. It reopens a closed contract
   that the listing holds again. It returns the listed ids that are not stored
   yet.
4. The job inserts the new contracts.

A closed contract carries three columns:

- **`last_seen_at`**: the snapshot time of the last listing that held it.
- **`closed_at`**: the snapshot time of the first listing without it.
- **`closure`**: `expired` if the contract's own expiry is at or before
  `closed_at`. Otherwise `gone`, which means somebody accepted it or the issuer
  withdrew it. ESI cannot tell those two apart.

An open contract is never written while it stays listed. Its last sighting is
the region's `observed_at`.

## When the job trusts a listing

The sweep closes what a listing lacks. A bad listing would therefore close good
contracts. The job closes nothing unless all of these are true:

- Every page arrived, as many as the first page's `X-Pages` declared.
- Every page except the last holds exactly 1000 contracts.
- All pages carry the same `Last-Modified`. Different values mean ESI made a
  new snapshot during the read.
- No contract id appears twice.

If a read fails these checks, the job reads the region once more. If the
second read also fails, the job closes nothing and asks again on the next run.

A region that held at least 100 contracts and now lists under a tenth of that
is held as suspect (`suspect_since`). The job closes nothing there for up to
six hours. If the drop is still there after that, the job accepts it.

## The Forge is capped

ESI lists a region in ascending contract id. On 2026-10-09 it served The Forge
as exactly 35 full pages: 35,000 contracts. The newest contract in that listing
was 44 minutes older than the snapshot, although The Forge gets about two new
public contracts a minute. So ESI cuts the listing off at its newest end.

The next snapshot, 30 minutes later, was again exactly 35,000. Its newest
contract was 69 minutes older than the snapshot. The highest contract id moved
up by only 91: 47 contracts closed and 46 entered. So a new contract enters the
listing only when an older one closes. When The Forge issues contracts faster
than they close, the delay grows.

This does not make a closure wrong. Contract ids only grow, so a listed
contract cannot be pushed out by newer ones. It leaves the listing only when it
closes. But a new contract in a capped region is not visible until enough
older ones close, which can take hours. The region row marks this with
`capped`, which means the last page was full. No other region was near the cap
on 2026-10-09: the next largest had three pages.

## Items

Each run reads the items of up to 1000 open item exchanges and auctions,
newest first, in eight lanes, for at most two minutes. A contract's items never
change, so each contract is read once. `items_status` records the answer:

- `200`: the items were stored.
- `204`: the contract had already gone. ESI sometimes sends an empty 200 for
  this; the job records it as 204.
- `404`: ESI does not know the contract.

The job never asks for a courier's items. ESI answers that with a 400, and a
400 spends ESI's error budget. If a failure reports the error budget nearly
spent, the job stops asking ESI for the rest of the run.

## Retention

Each run deletes up to 5000 contracts that closed more than 30 days ago
(`RETENTION_DAYS`). Their items go with them.

## Measured on 2026-10-09

| Measure | Value |
| :-- | --: |
| Open public contracts, all regions | 50,083 |
| The Forge | 35,000, capped |
| Forge sweep 30 minutes later | 47 closed, 46 new |
| First run, every region and 1000 item lists | 35 s |
| Item lines per itemised contract | about 4.5 |
| Later run, no region due, 1000 item lists | 24 s |

At 1000 item lists a run and four runs an hour, the first backlog clears in
about half a day.

## Example queries

Item exchanges that went before they expired, in the last day:

```sql
select c.contract_id, c.region_id, c.title, c.price, c.issuer_corporation_id, c.last_seen_at, c.closed_at
from public_contract c
where c.closure = 'gone'
  and c.type = 'item_exchange'
  and c.closed_at > now() - interval '1 day'
order by c.price desc nulls last;
```

Everything a corporation has on public contract now:

```sql
select c.*
from public_contract c
where c.issuer_corporation_id = 98000001
  and c.closed_at is null;
```

Who sells a type, and where:

```sql
select c.contract_id, c.region_id, c.start_location_id, c.price, i.quantity
from public_contract_item i
join public_contract c using (contract_id)
where i.type_id = 23919 -- Aeon
  and i.is_included
  and c.closed_at is null;
```

## Not done yet

- Auction bids (`/contracts/public/bids/{contract_id}/`).
- A page, GraphQL fields or MCP tools over these tables.

## Code

- `src/jobs/publicContracts.js`: the job.
- `src/jobs/publicContractFields.js`: the pure rules, tested in
  `test/publicContractFields.test.ts`.
- `public_contract_sweep()`: migration `20261009035853_public_contracts.sql`,
  tested in `test/sql/public_contract_sweep.sql`.
- `src/workflows/publicContracts.ts` and
  `src/app/api/cron/public-contracts/route.ts`: the schedule.
