# Contract status history

The `character-contracts` and `corp-contracts` extracts keep every status a
contract has held, with when it held it. Migration
`20261009051339_contract_status_history.sql` made this change.

## The model

A contract's facts are frozen once it is issued. EVE cannot edit a contract's
price, items, route or parties. Three kinds of data are kept:

- **Facts:** `character_contract` and `corp_contract` hold the facts, one row
  per contract and owner.
- **Fields that fill in:** `acceptor_id`, `date_accepted` and `date_completed`
  stay on those rows and are updated in place. Before a contract is accepted
  they are empty, so there is no earlier value worth keeping.
- **Status:** the status is history. It is in
  `character_contract_status_over_time` and `corp_contract_status_over_time`,
  one row for each status a contract has held. The views
  `character_contract_status` and `corp_contract_status` hold the current row.

The views `character_contract_with_status` and `corp_contract_with_status` put
the current status back beside the facts, with the same columns the tables had
before. The GraphQL `contracts` list reads them, and so do Data Links, CSV and
MCP `run_query`.

## When a status begins

`valid_from` is when the status began:

| Status | Begins at |
| :-- | :-- |
| `outstanding` | `date_issued` |
| `in_progress` | `date_accepted` |
| `finished`, `finished_issuer`, `finished_contractor` | `date_completed` |
| `cancelled`, `deleted`, `rejected`, `failed`, `reversed` | the scan that first saw it |

ESI gives no date for the states in the last row, so the scan time is the best
this database can say. If ESI leaves out a date it normally gives, the scan
time is used too.

A change ends the current row and starts a new one at the same moment, so the
rows are contiguous. A change is never dated before the row it ends began, so
history never runs backwards. On the current row, `valid_until` means nothing.
A status is never rewritten while it holds.

## What a scan writes

Each run upserts the facts, then calls `character_contract_status_sync()` or
`corp_contract_status_sync()` with every listed contract's status and its start
time (`contractStatus` in `src/jobs/contractFields.js`):

- **Same status as before:** nothing is written.
- **A different status:** the current row ends and a new row starts.
- **No status yet:** the first row starts.

ESI lists contracts from the last 30 days and anything still outstanding or in
progress. A contract that leaves that window keeps its last status, because
leaving the listing is not a change of state.

A run that dies between the facts and the statuses leaves contracts with no
status. The views read their status as null, and GraphQL reads it as
`unknown`. The next run fills them in.

## Backfill

The migration gave each stored contract one row, from the status it carried.
That row begins at ESI's date for that state, as in the table above. Where
there is no such date, it begins at `seen_at`, the last scan that saw the
contract. Earlier statuses of those contracts were never stored, so they are
not in the history.

## Tests

- `test/contractFields.test.ts`: `contractStatus`, and that the status is not
  on the contract row.
- `test/sql/contract_status_history.sql`: the backfill, the sync functions,
  the views, row-level security, and account deletion.
