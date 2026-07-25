// Filter-building and response-shaping for the list_structures MCP tool.
//
// corp_structure is a small table with the solar system and hull type already
// on the row, so both filters are ordinary PostgREST predicates — no RPC
// needed, but they still travel to Postgres rather than being applied to a
// drained result set. Like blueprintQuery.ts this module imports nothing, so
// the filter wiring and row shaping are unit-testable without a Supabase
// client (see test/).

// EVE's Upwell hull groups (stable SDE group ids). The kind filter resolves to
// the published types in these groups, which is what corp_structure.type_id
// holds — the same ids the blueprint tools already use to decide whether a
// structure's manufacturing/reaction role bonus applies (see tools.ts).
export const STRUCTURE_KIND_GROUPS = {
  citadel: 1657,
  engineering_complex: 1404,
  refinery: 1406,
} as const

export type StructureKind = keyof typeof STRUCTURE_KIND_GROUPS

// Tuple-typed (not string[]) so it can be handed straight to z.enum and the
// tool's `kind` argument comes back as a StructureKind rather than a string.
export const STRUCTURE_KINDS = [
  'citadel',
  'engineering_complex',
  'refinery',
] as const satisfies readonly StructureKind[]

export const groupIdForKind = (kind: StructureKind): number => STRUCTURE_KIND_GROUPS[kind]

// Human label for a hull group, so a structure whose kind wasn't filtered on
// still reports which class it belongs to.
export const kindForGroupId = (groupId: number | null | undefined): StructureKind | null =>
  STRUCTURE_KINDS.find((k) => STRUCTURE_KIND_GROUPS[k] === groupId) ?? null

// The subset of the PostgREST query builder these filters need, typed
// structurally so a test can pass a recorder in place of a live builder. The
// argument positions are loose, and the type is deliberately not generic in the
// builder: a self-referential `Q extends FilterableQuery<Q>` constraint sends
// tsc into "type instantiation is excessively deep" (TS2589) against
// PostgrestFilterBuilder's own generics.
export type FilterableQuery = {
  eq(column: string, value: any): any
  in(column: string, values: any[]): any
}

export type StructureFilters = {
  systemId?: number | null
  typeIds?: number[] | null
  corporationIds?: number[] | null
}

// An owner-name filter resolves to a mix of character registration ids and
// corporation ids; only the latter can match a corp_structure row.
export const corporationIdsFor = (ownerIds: Set<string> | null, corporationIds: string[]): number[] | null =>
  ownerIds == null ? null : corporationIds.filter((id) => ownerIds.has(id)).map(Number)

// Push the resolved filters into the query. A kind that matched no SDE types
// still applies as an empty `in`, so the tool reports "nothing" rather than
// silently widening to every structure. Returns `any` for the same TS2589
// reason as above — the caller chains .order()/.range() onto the result.
export const applyStructureFilters = (query: FilterableQuery, filters: StructureFilters): any => {
  const withSystem: FilterableQuery = filters.systemId != null ? query.eq('system_id', filters.systemId) : query
  const withKind: FilterableQuery = filters.typeIds != null ? withSystem.in('type_id', filters.typeIds) : withSystem
  return filters.corporationIds != null ? withKind.in('corporation_id', filters.corporationIds) : withKind
}

// ── Response shaping ──────────────────────────────────────────────────────
export type StructureRow = {
  structure_id: number | string
  corporation_id: number | string
  type_id: number | string
  system_id: number | string
  name: string | null
  state: string | null
  unanchors_at: string | null
  services: Array<{ name: string; state: string }> | null
  last_seen_at: string
}

export type StructureLookups = {
  ownerName: (corporationId: string) => string
  hullName: (typeId: number) => string
  hullGroupId: (typeId: number) => number | null
  systemName: (systemId: number) => string | null
  security: (systemId: number) => string | null
  fuelExpires: (structureId: string) => string | null
}

export const formatStructure = (row: StructureRow, lookups: StructureLookups): Record<string, unknown> => {
  const typeId = Number(row.type_id)
  const systemId = Number(row.system_id)
  const structureId = String(row.structure_id)
  const services = row.services ?? []
  return {
    // The id the industry tools take as structure_id, so a listing chains
    // straight into blueprint_for_product.
    structure_id: structureId,
    name: row.name ?? `Structure #${structureId}`,
    owner: lookups.ownerName(String(row.corporation_id)),
    hull: lookups.hullName(typeId),
    kind: kindForGroupId(lookups.hullGroupId(typeId)),
    system: lookups.systemName(systemId),
    security: lookups.security(systemId),
    state: row.state,
    fuel_expires: lookups.fuelExpires(structureId),
    ...(row.unanchors_at != null && { unanchors_at: row.unanchors_at }),
    online_services: services.filter((s) => s.state === 'online').map((s) => s.name),
    ...(services.some((s) => s.state !== 'online') && {
      offline_services: services.filter((s) => s.state !== 'online').map((s) => s.name),
    }),
    last_seen_at: row.last_seen_at,
  }
}
