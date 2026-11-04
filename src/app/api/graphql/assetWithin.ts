// The asset LOCATION and HANGAR filters of the GraphQL `assets` and `restock`
// lists follow each item's parent chain: an item inside a container, a ship or
// a corporation Office matches where the thing holding it matches. That walk
// runs in SQL — character_asset_within() / corp_asset_within(), see
// supabase/migrations/20261104180611_asset_within.sql — and this module builds
// what those two calls take and reads what they answer. Pure, like filters.ts
// and hangarFlags.ts, so test/graphqlAssetWithin.test.ts runs it under the
// node test runner.
import { isEmpty } from 'ramda'

export type AssetSide = 'character' | 'corporation'

// Every filter the walk takes, already resolved to ids and flags. `null` means
// "not filtered on this dimension".
export type WithinFilters = {
  typeIds: readonly number[] | null
  locationIds: readonly string[] | null
  include: readonly string[] | null
  exclude: readonly string[] | null
}

// Only a location or a hangar filter needs the walk. A type or owner filter
// alone reads the views directly, as it always did.
export const walksParents = ({ locationIds, include, exclude }: WithinFilters): boolean =>
  locationIds !== null || include !== null || exclude !== null

// An EMPTY list asks for nothing — a PostgREST `.in()` over no values matches
// no row. The SQL reads an empty array as "no filter" instead, so an empty list
// must never reach it. An empty exclusion drops nothing, so it is harmless.
export const matchesNothing = ({ typeIds, locationIds, include }: WithinFilters): boolean =>
  [typeIds, locationIds, include].some((list) => list !== null && isEmpty(list))

const FUNCTION_OF: Record<AssetSide, string> = {
  character: 'character_asset_within',
  corporation: 'corp_asset_within',
}

const OWNER_ARGUMENT_OF: Record<AssetSide, string> = {
  character: 'registration_ids',
  corporation: 'corporation_ids',
}

// The RPC for one owner side. `ownerIds` is the leak guard: on a Data Link the
// client is service-role, and the function filters every row by this list.
export const withinCall = (
  side: AssetSide,
  ownerIds: readonly string[],
  { typeIds, locationIds, include, exclude }: WithinFilters,
  rowLimit: number
): { fn: string; args: Record<string, unknown> } => ({
  fn: FUNCTION_OF[side],
  args: {
    [OWNER_ARGUMENT_OF[side]]: ownerIds,
    type_ids: typeIds,
    location_ids: locationIds,
    include_flags: include,
    exclude_flags: exclude,
    row_limit: rowLimit,
  },
})

export type WithinResult<T> = { total: number; rows: T[] }

// The function answers ONE json object: `total` over the whole filtered set,
// and at most `row_limit` rows in item_id order. A null answer is an empty set.
export const readWithinResult = <T>(data: unknown): WithinResult<T> => {
  const result = (data ?? {}) as { total?: number | string | null; rows?: T[] | null }
  return { total: Number(result.total ?? 0), rows: result.rows ?? [] }
}
