// Argument-building and response-shaping for the list_blueprints MCP tool.
//
// Every filter (item types, solar systems, owners, original/copy, ME/TE
// floors) and the by-type stack collapse are applied by the blueprint_search()
// Postgres function — see supabase/migrations/20260725000000_blueprint_search.sql.
// This module is the pure seam on either side of that call: it turns tool
// arguments into RPC parameters, and the RPC's json payload into the tool's
// response rows. It deliberately imports nothing, so the behaviour below is
// unit-testable without a database or a Supabase client (see test/).
export type BlueprintKind = 'original' | 'copy'
export type BlueprintGroup = 'none' | 'type'

// The RPC's parameter names, exactly as blueprint_search() declares them. A
// null means "no filter"; an empty array means "match nothing", which is how an
// owner filter that selected only characters excludes every corporation row.
export type BlueprintSearchParams = {
  type_ids: number[] | null
  system_ids: number[] | null
  character_ids: string[] | null
  corporation_ids: number[] | null
  kind_filter: BlueprintKind | null
  min_me: number | null
  min_te: number | null
  group_mode: BlueprintGroup
  row_limit: number
}

// Owner ids are registration uuids for characters and corporation ids for
// corp-owned rows (the convention fetchOwnerContext uses), so a resolved owner
// filter has to be split back into the two typed arrays the RPC takes.
export type OwnerIds = { characterIds: string[]; corporationIds: string[] }

export const partitionOwnerIds = (
  ownerIds: Set<string> | null,
  owners: OwnerIds
): Pick<BlueprintSearchParams, 'character_ids' | 'corporation_ids'> =>
  ownerIds == null
    ? { character_ids: null, corporation_ids: null }
    : {
        character_ids: owners.characterIds.filter((id) => ownerIds.has(id)),
        corporation_ids: owners.corporationIds.filter((id) => ownerIds.has(id)).map(Number),
      }

export type BlueprintToolArgs = {
  typeIds?: number[] | null
  systemIds?: number[] | null
  ownerIds?: Set<string> | null
  kind?: BlueprintKind
  minMe?: number
  minTe?: number
  group?: BlueprintGroup
  rowLimit: number
}

export const buildBlueprintParams = (args: BlueprintToolArgs, owners: OwnerIds): BlueprintSearchParams => ({
  type_ids: args.typeIds ?? null,
  system_ids: args.systemIds ?? null,
  ...partitionOwnerIds(args.ownerIds ?? null, owners),
  kind_filter: args.kind ?? null,
  min_me: args.minMe ?? null,
  min_te: args.minTe ?? null,
  group_mode: args.group ?? 'none',
  row_limit: args.rowLimit,
})

// ── Response shaping ──────────────────────────────────────────────────────
// blueprint_search() returns one json object: totals over the whole filtered
// set, plus at most row_limit already-sorted rows.
export type BlueprintDetailRow = {
  type_id: number
  type_name: string
  owner_id: string
  owner_kind: 'character' | 'corporation'
  kind: BlueprintKind
  material_efficiency: number | null
  time_efficiency: number | null
  runs: number | null
  quantity: number
  location_id: number | null
  location_name: string | null
  location_flag: string | null
  system_id: number | null
}

export type BlueprintGroupRow = {
  type_id: number
  type_name: string
  stacks: number
  quantity: number
  originals: number
  copies: number
  best_material_efficiency: number | null
  best_time_efficiency: number | null
  copy_runs: number
  systems: number
}

export type BlueprintSearchPayload = {
  group: BlueprintGroup
  total_stacks: number
  total_quantity: number
  originals: number
  copies: number
  distinct_types: number
  rows: BlueprintDetailRow[] | BlueprintGroupRow[]
}

// An empty payload for the "RPC errored or returned nothing" path, so the tool
// degrades to an empty result rather than throwing at the model.
export const EMPTY_BLUEPRINT_PAYLOAD: BlueprintSearchPayload = {
  group: 'none',
  total_stacks: 0,
  total_quantity: 0,
  originals: 0,
  copies: 0,
  distinct_types: 0,
  rows: [],
}

export type BlueprintLookups = {
  ownerName: (ownerId: string) => string
  systemName: (systemId: number) => string | null
  locationName: (row: BlueprintDetailRow) => string | null
}

const detailRow = (r: BlueprintDetailRow, lookups: BlueprintLookups) => ({
  blueprint: r.type_name,
  owner: lookups.ownerName(r.owner_id),
  kind: r.kind,
  material_efficiency: r.material_efficiency,
  time_efficiency: r.time_efficiency,
  // Only copies have a meaningful run count; originals run indefinitely.
  ...(r.kind === 'copy' && { runs: r.runs }),
  quantity: r.quantity,
  location: lookups.locationName(r),
  ...(r.system_id != null && lookups.systemName(r.system_id) != null && { system: lookups.systemName(r.system_id) }),
  hangar: r.location_flag,
})

const groupRow = (r: BlueprintGroupRow) => ({
  blueprint: r.type_name,
  stacks: r.stacks,
  quantity: r.quantity,
  originals: r.originals,
  copies: r.copies,
  best_material_efficiency: r.best_material_efficiency,
  best_time_efficiency: r.best_time_efficiency,
  ...(r.copies > 0 && { copy_runs: r.copy_runs }),
  systems: r.systems,
})

export const isGrouped = (payload: BlueprintSearchPayload): boolean => payload.group === 'type'

// The rows the tool reports, plus the total they were capped out of — grouped
// mode counts distinct blueprint types, detail mode counts stacks.
export const formatBlueprintRows = (
  payload: BlueprintSearchPayload,
  lookups: BlueprintLookups
): { rows: Array<Record<string, unknown>>; total: number; unit: string } =>
  isGrouped(payload)
    ? {
        rows: (payload.rows as BlueprintGroupRow[]).map(groupRow),
        total: payload.distinct_types,
        unit: 'blueprint types',
      }
    : {
        rows: (payload.rows as BlueprintDetailRow[]).map((r) => detailRow(r, lookups)),
        total: payload.total_stacks,
        unit: 'blueprints',
      }
