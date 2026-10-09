# Public contracts

The `public-contracts` extract keeps a copy of every public contract that New
Eden lists, open or closed. It never deletes one. The data is intel: who sells
what, where it moves by courier, and what leaves the market fast.

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

A contract's facts are frozen once it is issued. EVE cannot edit a contract's
price, items or route. Only its status changes. So the facts and the status are
in different tables:

- **`public_contract`**: the facts, one row per contract, written once.
- **`public_contract_status_over_time`**: the status, as an SCD-2 history. The
  view **`public_contract_status`** holds the current row of each contract.
- **`public_contract_item`**: the items of a contract, written once.
- **`public_contract_region`**: one row per region. It holds the snapshot time
  (ESI `Last-Modified`) last reconciled, when ESI's cache of it expires, the
  open count, and two flags described below.

Signed-in members can read all of these. Anonymous visitors cannot. Only the
service role writes, and it can only insert and update. It has no `DELETE`
grant on any of these tables, and no foreign key cascades.

## The status of a contract

A status row has one of three values:

- **`outstanding`**: the contract is listed.
- **`expired`**: the contract left the listing, and its own expiry is at or
  before the first snapshot without it.
- **`gone`**: the contract left the listing before its expiry. Somebody
  accepted it, or the issuer withdrew it. ESI cannot tell those two apart.

ESI lists only outstanding contracts. It does not list closed contracts, and
it does not say how a contract ended. The job therefore infers each change:

1. It reads every page of a region.
2. It checks that the pages make one whole snapshot (see below).
3. It calls `public_contract_sweep()`. That function gives a closed status to
   each outstanding contract of the region that the listing does not hold. It
   gives `outstanding` again to a closed contract that the listing holds. It
   returns the listed ids that have no status yet.
4. The job inserts the facts of those contracts, then calls
   `public_contract_open()` to give each its first status, `outstanding`.

A change never edits a status in place. It ends the current row and starts a
new one:

- **`valid_from`** is the snapshot time of the first listing that showed the
  new status.
- **`valid_until`** on the ended row is the snapshot time of the last listing
  that confirmed the old status.

So the gap between the two is the window in which the change happened. For a
`gone` contract, that window is when it was accepted or withdrawn.

A status is never written while it holds. On the current row, `valid_until`
means nothing, and the region's `observed_at` is the last sighting.

If the job stops after it stores a contract's facts but before it opens its
status, the next sweep returns that contract as new again. Both writes skip
what already exists, so the next run finishes the work.

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

Each run reads the items of up to 1000 outstanding item exchanges and
auctions, newest first (`public_contract_items_owed()`), in eight lanes, for at
most two minutes. A contract's items never
change, so each contract is read once. `items_status` records the answer:

- `200`: the items were stored.
- `204`: the contract had already gone. ESI sometimes sends an empty 200 for
  this; the job records it as 204.
- `404`: ESI does not know the contract.

The job never asks for a courier's items. ESI answers that with a 400, and a
400 spends ESI's error budget. If a failure reports the error budget nearly
spent, the job stops asking ESI for the rest of the run.

## Nothing is deleted

The tables only grow. In the Forge window measured below, 47 contracts closed
and 46 entered in 30 minutes, which is about 2,300 a day for The Forge alone.
Expect on the order of a million contracts a year across New Eden, about two
status rows each, and about 4.5 item lines for each itemised contract. That is
an estimate from one window, not a measurement over time.

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

Item exchanges that went before they expired, in the last day, with the
window in which each went:

```sql
select c.contract_id, c.region_id, c.title, c.price, c.issuer_corporation_id,
       previous.valid_until as last_listed, s.valid_from as first_missing
from public_contract_status s
join public_contract c using (contract_id)
cross join lateral (
  select p.valid_until
  from public_contract_status_over_time p
  where p.contract_id = s.contract_id and not p.is_current
  order by p.valid_from desc
  limit 1
) previous
where s.status = 'gone'
  and c.type = 'item_exchange'
  and s.valid_from > now() - interval '1 day'
order by c.price desc nulls last;
```

Everything a corporation has on public contract now:

```sql
select c.*
from public_contract c
join public_contract_status s using (contract_id)
where c.issuer_corporation_id = 98000001
  and s.status = 'outstanding';
```

Who sells a type, and where:

```sql
select c.contract_id, c.region_id, c.start_location_id, c.price, i.quantity
from public_contract_item i
join public_contract c using (contract_id)
join public_contract_status s using (contract_id)
where i.type_id = 23919 -- Aeon
  and i.is_included
  and s.status = 'outstanding';
```

Every status a contract has held:

```sql
select status, valid_from, valid_until, is_current
from public_contract_status_over_time
where contract_id = 236840715
order by valid_from;
```

## Not done yet

- Auction bids (`/contracts/public/bids/{contract_id}/`).
- A page, GraphQL fields or MCP tools over these tables.

## Code

- `src/jobs/publicContracts.js`: the job.
- `src/jobs/publicContractFields.js`: the pure rules, tested in
  `test/publicContractFields.test.ts`.
- `public_contract_sweep()`, `public_contract_open()` and
  `public_contract_items_owed()`: migration
  `20261009035853_public_contracts.sql`, tested in
  `test/sql/public_contract_sweep.sql`.
- `src/workflows/publicContracts.ts` and
  `src/app/api/cron/public-contracts/route.ts`: the schedule.
