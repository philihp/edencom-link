// The identity of an appraisal request: same market + same items = same key.
//
// Split out of src/innominate.ts as a pure seam (no I/O, no path aliases) so
// `pnpm test` can exercise it without a Supabase or queue client — the same
// reason blueprintQuery/structureQuery/planetQuery live apart from their tools.
//
// This key is load-bearing in two places that both impose a size limit, which
// is why it is a digest rather than the serialized item list it describes:
//
//   1. It is `innominate_appraisal.request_key`, a `text primary key`. A btree
//      index row caps at 2704 bytes, so a long key makes the upsert fail
//      outright ("index row size N exceeds btree version 4 maximum 2704").
//   2. It rides to the queue as the `Vqs-Idempotency-Key` HTTP header, which
//      is rejected long before that.
//
// Serializing the items inline hit both on any sizeable hangar, and because the
// threshold depends on how well the names happen to compress, it failed
// unpredictably — small stacks fine, a station's worth of types not. A digest
// is fixed-width no matter how many lines go in.
import { createHash } from 'node:crypto'

import { sortBy } from 'ramda'

export type KeyItem = { name: string; quantity: number }

// The canonical form the digest is taken over. Sorted by name so batches that
// differ only in order share a key (and therefore a cache entry); quantities
// included so a different amount is genuinely a different request.
export const canonicalRequest = (items: KeyItem[], market: string): string =>
  JSON.stringify({ market, items: sortBy((i: KeyItem) => i.name, items).map((i) => [i.name, i.quantity]) })

export const requestKeyFor = (items: KeyItem[], market: string): string =>
  createHash('sha256').update(canonicalRequest(items, market)).digest('hex')
