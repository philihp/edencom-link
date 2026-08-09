// The pure mapping from ESI's contract payloads to the table columns, shared by
// the character-contracts and corp-contracts extracts — the two endpoints
// return the identical contract shape, only the owner column differs, so this
// is the one place field names and nullability are decided. No I/O; tested in
// test/contractFields.test.ts.

// Contract types that have an item list worth fetching. `loan` never has one,
// and `unknown` is ESI's placeholder for a type it couldn't classify — asking
// for either just spends a request to be told nothing.
export const ITEMISED_TYPES = ['item_exchange', 'auction', 'courier']

// ESI omits the money fields entirely on contracts that don't use them (a
// courier has reward and collateral but no price or buyout), so every optional
// numeric is coalesced to null rather than 0 — "not applicable" and "zero ISK"
// are different facts about a contract.
const numberOrNull = (value) => (value == null ? null : Number(value))

// One contract's shared columns. `seenAt` is stamped by the caller so every row
// in a run carries the same observation time.
export const contractFields = (c, seenAt) => ({
  contract_id: c.contract_id,
  type: c.type ?? 'unknown',
  status: c.status,
  availability: c.availability,
  for_corporation: c.for_corporation ?? false,
  issuer_id: c.issuer_id,
  issuer_corporation_id: c.issuer_corporation_id,
  assignee_id: c.assignee_id ?? null,
  acceptor_id: c.acceptor_id ?? null,
  start_location_id: c.start_location_id ?? null,
  end_location_id: c.end_location_id ?? null,
  title: c.title ?? null,
  price: numberOrNull(c.price),
  reward: numberOrNull(c.reward),
  collateral: numberOrNull(c.collateral),
  buyout: numberOrNull(c.buyout),
  volume: numberOrNull(c.volume),
  days_to_complete: c.days_to_complete ?? null,
  date_issued: c.date_issued,
  date_expired: c.date_expired,
  date_accepted: c.date_accepted ?? null,
  date_completed: c.date_completed ?? null,
  seen_at: seenAt,
  // items_fetched_at is deliberately absent: PostgREST builds the ON CONFLICT
  // update list from the keys present in the payload, so leaving it out is what
  // keeps a re-scan of an already-itemised contract from resetting it to null
  // and re-fetching its items every run.
})

// One contract item's shared columns. raw_quantity is ESI's blueprint marker
// (-1 original, -2 copy) and is absent for ordinary items.
export const contractItemFields = (item, seenAt) => ({
  record_id: item.record_id,
  type_id: item.type_id,
  quantity: item.quantity,
  is_included: item.is_included ?? true,
  is_singleton: item.is_singleton ?? false,
  raw_quantity: item.raw_quantity ?? null,
  seen_at: seenAt,
})
