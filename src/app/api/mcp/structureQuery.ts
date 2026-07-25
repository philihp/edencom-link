// Filter-building and response-shaping for the list_structures MCP tool
// (docs/mcp-tools-spec.md §3).
//
// corp_structure is a small table with the solar system, hull type and owner
// already on the row, so those filters are ordinary PostgREST predicates — no
// RPC needed, but they still travel to Postgres rather than being applied to a
// drained result set. Like blueprintQuery.ts this module imports nothing, so
// the filter wiring and row shaping are unit-testable without a Supabase
// client (see test/).

// EVE's Upwell hull groups (stable SDE group ids). Engineering complexes carry
// a 1% manufacturing material role bonus, refineries a 1% reaction one, and
// citadels neither — the same classification tools.ts already uses to decide
// whether a structure's role bonus applies to a given activity.
export const ENGINEERING_COMPLEX_GROUP = 1404
export const REFINERY_GROUP = 1406
export const CITADEL_GROUP = 1657

export type StructureClass = 'citadel' | 'engineering_complex' | 'refinery'

export const classForGroupId = (groupId: number | null | undefined): StructureClass | null =>
  groupId === CITADEL_GROUP
    ? 'citadel'
    : groupId === ENGINEERING_COMPLEX_GROUP
      ? 'engineering_complex'
      : groupId === REFINERY_GROUP
        ? 'refinery'
        : null

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

// PostgREST passes the pattern through to SQL LIKE, so a user-supplied % or _
// would otherwise widen the match rather than being matched literally.
export const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (c) => `\\${c}`)

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

// The material-efficiency picture blueprint_for_product derives internally from
// a structure_id. Exposing it is the point of this tool: it lets the agent
// explain why a material requirement came out at 18 instead of 20 without a
// second round trip.
export type MeBonus = {
  activity: 'manufacturing' | 'reaction'
  role_bonus: number
  rig_bonus: number
  security_multiplier: number
  security_band: string
  // Combined material reduction as a fraction, e.g. 0.0604 for a 6.04% saving.
  total_reduction: number
}

// A refinery's role bonus applies to reactions; every other Upwell hull that
// has a role bonus applies it to manufacturing. cost() composes the three
// reductions multiplicatively:  (1 - role) × (1 - rig × security).
export const computeMeBonus = (
  groupId: number | null,
  rigBonus: number,
  security: { multiplier: number; band: string }
): MeBonus => {
  const activity = groupId === REFINERY_GROUP ? 'reaction' : 'manufacturing'
  const roleBonus = groupId === ENGINEERING_COMPLEX_GROUP || groupId === REFINERY_GROUP ? 0.01 : 0
  const totalReduction = 1 - (1 - roleBonus) * (1 - rigBonus * security.multiplier)
  return {
    activity,
    role_bonus: roleBonus,
    rig_bonus: rigBonus,
    security_multiplier: security.multiplier,
    security_band: security.band,
    // Six places is well past what any material count can resolve, and keeps
    // the float noise out of the response.
    total_reduction: Number(totalReduction.toFixed(6)),
  }
}

// Tier of a Standup material-efficiency rig from its name: the "… II" variant
// is T2 (2.4% base), the "… I" variant T1 (2.0%). Mirrors tools.ts.
export const rigBonusFromName = (name: string): number => (/\bII$/.test(name.trim()) ? 0.024 : 0.02)

// The strongest ME rig fitted; structures rarely carry more than one relevant
// rig, and cost() takes a single knob.
export const bestRigBonus = (rigNames: string[]): number =>
  rigNames
    .filter((n) => /Material Efficiency/i.test(n))
    .map(rigBonusFromName)
    .reduce((best, b) => Math.max(best, b), 0)

export type StructureLookups = {
  ownerName: (corporationId: string) => string
  hullName: (typeId: number) => string
  hullGroupId: (typeId: number) => number | null
  systemName: (systemId: number) => string | null
  security: (systemId: number) => { multiplier: number; band: string; display: string | null }
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
  const security = lookups.security(systemId)
  return {
    // The id blueprint_for_product takes as structure_id, so a listing chains
    // straight into the industry tools without the caller guessing ids.
    structure_id: structureId,
    name: row.name ?? `Structure #${structureId}`,
    owner: lookups.ownerName(String(row.corporation_id)),
    type: lookups.hullName(typeId),
    class: classForGroupId(groupId),
    system: lookups.systemName(systemId),
    security: security.display,
    state: row.state,
    fuel_expires: lookups.fuelExpires(structureId),
    ...(row.unanchors_at != null && { unanchors_at: row.unanchors_at }),
    services: services.filter((s) => s.state === 'online').map((s) => s.name),
    ...(services.some((s) => s.state !== 'online') && {
      offline_services: services.filter((s) => s.state !== 'online').map((s) => s.name),
    }),
    rigs,
    me_bonus: computeMeBonus(groupId, bestRigBonus(rigs), security),
    // A rig only bonuses products its filter covers (an Equipment rig does
    // nothing for a ship build), and that can't be decided without knowing what
    // is being built — so the rig half of me_bonus is a best case. The tools
    // that do know the product apply the real test; say so rather than letting
    // the number read as settled.
    ...(bestRigBonus(rigs) > 0 && {
      me_bonus_assumes_applicable_rig:
        "rig_bonus assumes a fitted ME rig covers what you're building. Use rigs_for_blueprint, or pass this structure_id to blueprint_for_product, to apply the real per-product test.",
    }),
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
