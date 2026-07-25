// Argument-building and response-shaping for the list_blueprints MCP tool
// (docs/mcp-tools-spec.md §1).
//
// Every filter (item types, solar systems, structures, owners, original/copy,
// ME/TE floors, researchability), the collapse and the limit are applied by the
// blueprint_search() Postgres function — see
// supabase/migrations/20260725000000_blueprint_search.sql. This module is the
// pure seam on either side of that call: it turns tool arguments into RPC
// parameters, and the RPC's json payload into the tool's response rows. It
// deliberately pulls in no I/O — only ramda and ts-pattern — so the behaviour
// below is unit-testable without a database or a Supabase client (see test/).
import { filter, join, map } from 'ramda'
import { match } from 'ts-pattern'

export type BlueprintKind = 'original' | 'copy' | 'all'
export type BlueprintGroup = 'none' | 'type' | 'type_location'

// The spec's default display cap, and the ceiling blueprint_search() clamps to.
export const DEFAULT_LIMIT = 100
export const MAX_LIMIT = 500

// The RPC's parameter names, exactly as blueprint_search() declares them. A
// null means "no filter"; an empty array means "match nothing", which is how an
// owner filter that selected only characters excludes every corporation row.
export type BlueprintSearchParams = {
  type_ids: number[] | null
  system_ids: number[] | null
  structure_ids: number[] | null
  character_ids: string[] | null
  corporation_ids: number[] | null
  kind_filter: BlueprintKind
  below_me: number | null
  below_te: number | null
  researchable_only: boolean
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
  structureIds?: number[] | null
  ownerIds?: Set<string> | null
  kind?: BlueprintKind
  belowMe?: number
  belowTe?: number
  researchable?: boolean
  group?: BlueprintGroup
  limit?: number
}

export const clampLimit = (limit: number | undefined): number =>
  limit == null ? DEFAULT_LIMIT : Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT)

export const buildBlueprintParams = (args: BlueprintToolArgs, owners: OwnerIds): BlueprintSearchParams => ({
  type_ids: args.typeIds ?? null,
  system_ids: args.systemIds ?? null,
  structure_ids: args.structureIds ?? null,
  ...partitionOwnerIds(args.ownerIds ?? null, owners),
  kind_filter: args.kind ?? 'all',
  below_me: args.belowMe ?? null,
  below_te: args.belowTe ?? null,
  researchable_only: args.researchable ?? false,
  group_mode: args.group ?? 'none',
  row_limit: clampLimit(args.limit),
})

// ── Response shaping ──────────────────────────────────────────────────────
// blueprint_search() returns one json object: totals over the whole filtered
// set, plus at most row_limit already-sorted rows.
export type BlueprintDetailRow = {
  type_id: number
  type_name: string
  owner_id: string
  owner_kind: 'character' | 'corporation'
  kind: 'original' | 'copy'
  material_efficiency: number | null
  time_efficiency: number | null
  runs: number | null
  quantity: number
  researchable: boolean
  location_id: number | null
  location_name: string | null
  location_flag: string | null
  system_id: number | null
}

export type BlueprintGroupRow = {
  type_id: number
  type_name: string
  material_efficiency: number | null
  time_efficiency: number | null
  stacks: number
  quantity: number
  originals: number
  copies: number
  copy_runs: number
  researchable: boolean
  location_id: number | null
  location_name: string | null
  system_id: number | null
}

export type BlueprintSearchPayload = {
  group: BlueprintGroup
  total_stacks: number
  total_quantity: number
  originals: number
  copies: number
  distinct_types: number
  total_groups: number | null
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
  total_groups: null,
  rows: [],
}

export type BlueprintLookups = {
  ownerName: (ownerId: string) => string
  systemName: (systemId: number) => string | null
  locationName: (row: { location_id: number | null; location_name: string | null }) => string | null
}

export const isGrouped = (payload: BlueprintSearchPayload): boolean => payload.group !== 'none'

const detailRow = (r: BlueprintDetailRow, lookups: BlueprintLookups) => ({
  blueprint: r.type_name,
  owner: lookups.ownerName(r.owner_id),
  kind: r.kind,
  material_efficiency: r.material_efficiency,
  time_efficiency: r.time_efficiency,
  // Only copies have a meaningful run count; an original is runs = -1.
  ...(r.kind === 'copy' && { runs: r.runs }),
  quantity: r.quantity,
  location: lookups.locationName(r),
  ...(r.system_id != null && lookups.systemName(r.system_id) != null && { system: lookups.systemName(r.system_id) }),
  hangar: r.location_flag,
  // Surfaced so the model can see why a 0/0 row is not a research candidate.
  ...(!r.researchable && { researchable: false }),
})

const groupRow = (r: BlueprintGroupRow, lookups: BlueprintLookups) => ({
  blueprint: r.type_name,
  material_efficiency: r.material_efficiency,
  time_efficiency: r.time_efficiency,
  stacks: r.stacks,
  quantity: r.quantity,
  originals: r.originals,
  copies: r.copies,
  ...(r.copies > 0 && { copy_runs: r.copy_runs }),
  ...(r.location_id != null && { location: lookups.locationName(r) }),
  ...(r.system_id != null && lookups.systemName(r.system_id) != null && { system: lookups.systemName(r.system_id) }),
  ...(!r.researchable && { researchable: false }),
})

// The rows the tool reports, plus the total they were capped out of — a grouped
// result counts groups, an ungrouped one counts stacks. Matched on group_mode
// exhaustively rather than through isGrouped() plus a nested ternary: the three
// modes each name their own unit, and .exhaustive() means a fourth BlueprintGroup
// member fails the build here instead of silently reporting "blueprint groups".
export const formatBlueprintRows = (
  payload: BlueprintSearchPayload,
  lookups: BlueprintLookups
): { rows: Array<Record<string, unknown>>; total: number; unit: string } => {
  const asGroups = (unit: string) => ({
    rows: (payload.rows as BlueprintGroupRow[]).map((r) => groupRow(r, lookups)),
    total: payload.total_groups ?? payload.rows.length,
    unit,
  })
  return match(payload.group)
    .with('type_location', () => asGroups('blueprint/location groups'))
    .with('type', () => asGroups('blueprint groups'))
    .with('none', () => ({
      rows: (payload.rows as BlueprintDetailRow[]).map((r) => detailRow(r, lookups)),
      total: payload.total_stacks,
      unit: 'blueprints',
    }))
    .exhaustive()
}

// A truncation note that says what was filtered and what to narrow next — the
// old note ("Showing the first 200 of 10968 blueprints") gave the agent nothing
// to act on, which is half of what the spec is complaining about.
export type AppliedFilters = {
  item?: string
  owner?: string
  system?: string
  structure?: string
  kind?: BlueprintKind
  below_me?: number
  below_te?: number
  researchable?: boolean
  group?: BlueprintGroup
}

const SUGGESTIONS: Array<{ key: keyof AppliedFilters; hint: string }> = [
  { key: 'system', hint: 'system to one solar system' },
  { key: 'structure', hint: 'structure to one structure' },
  { key: 'item', hint: 'item to a name substring' },
  { key: 'owner', hint: 'owner to one character or corporation' },
  { key: 'kind', hint: "kind to 'original' or 'copy'" },
  { key: 'researchable', hint: 'researchable to drop reaction formulas' },
]

// A filter counts as applied when it is present and, for the boolean flags, true.
type FilterPair = [key: string, value: unknown]

const isSet = (value: unknown): boolean => value != null && value !== false

// Object.entries rather than ramda's toPairs: every AppliedFilters property is
// optional, which makes @types/ramda infer each pair as `[K, V] | undefined` and
// breaks the destructuring below. The filter and map themselves are ramda's.
export const describeFilters = (applied: AppliedFilters): string => {
  const parts = map(
    ([key, value]: FilterPair) => `${key}=${value}`,
    filter(([, value]: FilterPair) => isSet(value), Object.entries(applied))
  )
  return parts.length === 0 ? 'no filters' : join(', ', parts)
}

export const truncationNote = (
  total: number,
  shown: number,
  unit: string,
  applied: AppliedFilters,
  limit: number
): string | undefined => {
  if (total <= shown) return undefined
  const unset = SUGGESTIONS.filter(({ key }) => applied[key] == null || applied[key] === false)
  // Collapsing leads: on a hangar of thousands it cuts the row count hardest,
  // and only the first few hints survive the slice below.
  const narrowing =
    applied.group == null || applied.group === 'none'
      ? ["group='type' to collapse identical stacks", ...unset.map((s) => s.hint)]
      : unset.map((s) => s.hint)
  return (
    `Showing ${shown} of ${total} ${unit} (filters: ${describeFilters(applied)}); ` +
    `counts and totals cover everything. To see more, ${
      narrowing.length > 0 ? `narrow with ${narrowing.slice(0, 3).join(', ')}, or ` : ''
    }raise limit (currently ${limit}, max ${MAX_LIMIT}).`
  )
}
