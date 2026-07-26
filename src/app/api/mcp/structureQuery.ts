// Filter-building and response-shaping for the list_structures MCP tool
// (docs/mcp-tools-spec.md §3).
//
// corp_structure is a small table with the solar system, hull type and owner
// already on the row, so those filters are ordinary PostgREST predicates — no
// RPC needed, but they still travel to Postgres rather than being applied to a
// drained result set. Like blueprintQuery.ts this module pulls in no I/O — only
// ts-pattern — so the filter wiring and row shaping are unit-testable without a
// Supabase client (see test/).
import { match } from 'ts-pattern'

// Relative + .ts, like rigs.ts: this module is unit-tested by `pnpm test`,
// which runs Node's stripped-types loader with no path-alias resolution.
import { escapeLike } from '../../../utils/escapeLike.ts'

// EVE's Upwell hull groups (stable SDE group ids). Engineering complexes carry
// a 1% manufacturing material role bonus, refineries a 1% reaction one, and
// citadels neither — tools.ts imports these to decide whether a structure's
// role bonus applies to a given activity, so the ids live here only.
export const ENGINEERING_COMPLEX_GROUP = 1404
export const REFINERY_GROUP = 1406
export const CITADEL_GROUP = 1657

export type StructureClass = 'citadel' | 'engineering_complex' | 'refinery'

export const classForGroupId = (groupId: number | null | undefined): StructureClass | null =>
  match(groupId)
    .with(CITADEL_GROUP, (): StructureClass => 'citadel')
    .with(ENGINEERING_COMPLEX_GROUP, (): StructureClass => 'engineering_complex')
    .with(REFINERY_GROUP, (): StructureClass => 'refinery')
    .otherwise(() => null)

// The subset of the PostgREST query builder these filters need, typed
// structurally so a test can pass a recorder in place of a live builder. The
// argument positions are loose, and the type is deliberately not generic in the
// builder: a self-referential `Q extends FilterableQuery<Q>` constraint sends
// tsc into "type instantiation is excessively deep" (TS2589) against
// PostgrestFilterBuilder's own generics.
export type FilterableQuery = {
  eq(column: string, value: any): any
  in(column: string, values: any[]): any
  ilike(column: string, pattern: string): any
}

export type StructureFilters = {
  systemId?: number | null
  name?: string | null
  corporationIds?: number[] | null
}

// An owner-name filter resolves to a mix of character registration ids and
// corporation ids; only the latter can match a corp_structure row.
export const corporationIdsFor = (ownerIds: Set<string> | null, corporationIds: string[]): number[] | null =>
  ownerIds == null ? null : corporationIds.filter((id) => ownerIds.has(id)).map(Number)

// Re-exported so this module stays the one import site for the structure
// filters; the implementation moved to src/utils/ once the SDE loaders needed
// it too (a loader importing from the MCP layer would invert the layering).
export { escapeLike }

// Push the resolved filters into the query. Returns `any` for the same TS2589
// reason as above — the caller chains .order()/.range() onto the result.
export const applyStructureFilters = (query: FilterableQuery, filters: StructureFilters): any => {
  const withSystem: FilterableQuery = filters.systemId != null ? query.eq('system_id', filters.systemId) : query
  const withName: FilterableQuery =
    filters.name != null && filters.name.trim() !== ''
      ? withSystem.ilike('name', `%${escapeLike(filters.name.trim())}%`)
      : withSystem
  return filters.corporationIds != null ? withName.in('corporation_id', filters.corporationIds) : withName
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
  rigs: (structureId: string) => string[]
}

export const formatStructure = (row: StructureRow, lookups: StructureLookups): Record<string, unknown> => {
  const typeId = Number(row.type_id)
  const systemId = Number(row.system_id)
  const structureId = String(row.structure_id)
  const services = row.services ?? []
  const groupId = lookups.hullGroupId(typeId)
  const rigs = lookups.rigs(structureId)
  return {
    // The id blueprint_for_product takes as structure_id, so a listing chains
    // straight into the industry tools without the caller guessing ids.
    structure_id: structureId,
    name: row.name ?? `Structure #${structureId}`,
    owner: lookups.ownerName(String(row.corporation_id)),
    type: lookups.hullName(typeId),
    class: classForGroupId(groupId),
    system: lookups.systemName(systemId),
    security: lookups.security(systemId),
    state: row.state,
    fuel_expires: lookups.fuelExpires(structureId),
    ...(row.unanchors_at != null && { unanchors_at: row.unanchors_at }),
    services: services.filter((s) => s.state === 'online').map((s) => s.name),
    ...(services.some((s) => s.state !== 'online') && {
      offline_services: services.filter((s) => s.state !== 'online').map((s) => s.name),
    }),
    // The rigs are the raw fact; the material bonus they produce is not
    // computable here. It depends on what is being built (a rig only covers the
    // product groups its filter names), and where it is computed at all, it is
    // eve-industry's cost() that does it — see blueprint_for_product. A
    // me_bonus field here could only ever be a guess dressed as a number, and a
    // second hand-rolled copy of that library's math.
    rigs,
    last_seen_at: row.last_seen_at,
  }
}

// Service filtering is the one predicate that stays in JS: `services` is a
// jsonb array of {name, state} objects, and PostgREST's containment operator
// can only match whole objects, not the case-insensitive substrings the spec
// asks for ("manufacturing"). corp_structure holds dozens of rows per account,
// not the five figures that motivated pushing the blueprint filters into SQL.
export const matchesServices = (row: StructureRow, wanted: string[] | undefined): boolean => {
  if (wanted == null || wanted.length === 0) return true
  const online = (row.services ?? []).filter((s) => s.state === 'online').map((s) => s.name.toLowerCase())
  return wanted.every((w) => online.some((name) => name.includes(w.trim().toLowerCase())))
}
