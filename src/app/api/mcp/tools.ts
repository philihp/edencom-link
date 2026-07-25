// The MCP tools: read-only questions over the extracted EVE data ("where
// is my titan", "how many fuel blocks do I have in EKPB-3"). Tools accept
// fuzzy names (items, systems, owners) and return resolved names, mirroring
// the equivalent web pages' queries — the DB is the only source here; MCP
// never calls ESI (see the data-flow rule in CLAUDE.md). Auth: withMcpAuth
// (route.ts) verifies the caller's OAuth bearer token, and every query runs
// on a client carrying that token, so RLS scopes results to the caller.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import {
  cost,
  type BlueprintME,
  type ModifierParams,
  type RigBonus,
  type SecBonus,
  type StructureBonus,
} from 'eve-industry'
import { prop, uniqBy } from 'ramda'
import { z } from 'zod'

import { rigAppliesToProduct } from '@/app/blueprint/rigs'
import { ACTIVITY_NAMES } from '@/app/industry/jobFields'
import { appraise, MARKETS, type AppraisalItemInput, type Market } from '@/innominate'
import { resolveLocations, type LocationRef } from '@/app/resolveLocations'
import { fetchSystemNames } from '@/app/systemNames'
import {
  getBlueprintForProduct,
  getBlueprintsForMaterial,
  MANUFACTURING,
  REACTION,
  type Blueprint,
} from '@/sdeBlueprints'
import { formatSecurity, getSdeSystem, getSdeSystemNames, getSdeSystems, searchSdeSystems } from '@/sdeSystems'
import { getSdeType, getSdeTypeNames, getSdeTypes, searchSdeTypesAll } from '@/sdeTypes'
import { AT_PARAM_ERROR, parseAtParam } from '@/utils/atParam'
import { createBearerClient } from '@/utils/supabase/bearer'

import {
  buildBlueprintParams,
  DEFAULT_LIMIT as DEFAULT_BLUEPRINT_LIMIT,
  EMPTY_BLUEPRINT_PAYLOAD,
  formatBlueprintRows,
  MAX_LIMIT as MAX_BLUEPRINT_LIMIT,
  truncationNote,
  type BlueprintSearchPayload,
} from './blueprintQuery'
import {
  applyStructureFilters,
  corporationIdsFor,
  escapeLike,
  type FilterableQuery,
  formatStructure,
  matchesServices,
  type StructureRow,
} from './structureQuery'
import {
  dataFreshness,
  fetchAllRows,
  fetchOwnerContext,
  guessLocationRef,
  resolveOwnerFilter,
  resolveTypeFilter,
  textResult,
} from './lib'

// Keep individual responses readable — totals/summaries always cover the full
// result set, only the itemized list is capped.
const MAX_ROWS = 200

// The time-travel knob on the tools whose tables keep SCD-2 history. Parsed by
// the same parseAtParam the Sheets endpoints' `at=` uses, so partial dates work.
const AS_OF_SHAPE = z
  .string()
  .optional()
  .describe(
    'Reconstruct the snapshot as it stood at this UTC moment instead of now. ISO 8601, partial dates allowed ("2026-06", "2026-06-01", "2026-06-01T12:00:00Z").'
  )

type SupabaseClient = ReturnType<typeof createBearerClient>

const clientFor = (extra: { authInfo?: AuthInfo }): SupabaseClient | null =>
  extra.authInfo?.token ? createBearerClient(extra.authInfo.token) : null

// Solar-system names resolve from the nightly-mirrored SDE tables first (known
// space), falling back to the universe_name cache for anything the SDE doesn't
// carry (e.g. wormhole systems).
const resolveSystemNames = async (supabase: SupabaseClient, systemIds: number[]): Promise<Record<number, string>> => {
  const fromSde = await getSdeSystemNames(systemIds)
  const missing = systemIds.filter((id) => !(id in fromSde))
  const fromDb = await fetchSystemNames(missing, supabase)
  return { ...fromDb, ...fromSde }
}

const typeName = (names: Record<number, string>, typeId: number | string | null | undefined): string =>
  typeId == null ? '—' : (names[Number(typeId)] ?? `Type #${typeId}`)

// Canonicalize a fuzzy solar-system name through the SDE search, the way
// search_assets does ("ekpb" → EKPB-3). Unlike search_assets — which compares
// the canonicalized *name* against already-fetched rows — the tools below pass
// the resolved id down so the filter runs in the query.
type SystemMatch = { ok: true; system: { systemID: number; name: string } | null } | { ok: false; message: string }

const resolveOneSystem = async (system: string | undefined): Promise<SystemMatch> => {
  const trimmed = (system ?? '').trim()
  if (trimmed === '') return { ok: true, system: null }
  const [best] = await searchSdeSystems(trimmed, 1)
  if (!best) return { ok: false, message: `No solar system matched "${trimmed}".` }
  return { ok: true, system: { systemID: best.systemID, name: best.name } }
}

// Resolve a fuzzy structure name to the ids a blueprint's location_id can
// carry. universe_structure holds every player structure the app has resolved a
// name for, so the match happens there and only ids travel into the query.
type StructureMatch = { ok: true; structureIds: number[] | null; name: string | null } | { ok: false; message: string }

const resolveStructures = async (supabase: SupabaseClient, structure: string | undefined): Promise<StructureMatch> => {
  const trimmed = (structure ?? '').trim()
  if (trimmed === '') return { ok: true, structureIds: null, name: null }
  const { data } = await supabase
    .from('universe_structure')
    .select('structure_id, name')
    .ilike('name', `%${escapeLike(trimmed)}%`)
  const matches = (data ?? []) as Array<{ structure_id: number | string; name: string | null }>
  if (matches.length === 0) return { ok: false, message: `No known structure matched "${trimmed}".` }
  return {
    ok: true,
    structureIds: matches.map((m) => Number(m.structure_id)),
    name: matches.length === 1 ? (matches[0].name ?? trimmed) : `${trimmed} (${matches.length} structures)`,
  }
}

const capNote = (total: number, shown: number, what: string): string | undefined =>
  total > shown ? `Showing the first ${shown} of ${total} ${what}; counts and totals cover everything.` : undefined

// Resolve a fuzzy item name to the single best-matching SDE type (highest
// coverage rank), surfacing the runner-up names so the model can correct a
// mis-pick. Used by the blueprint tools, which each act on one type.
type ResolvedType = { ok: true; typeID: number; name: string; alsoMatched: string[] } | { ok: false; message: string }

const resolveOneType = async (query: string): Promise<ResolvedType> => {
  const matches = await searchSdeTypesAll(query.trim())
  if (matches.length === 0) return { ok: false, message: `No item type matched "${query}".` }
  const [best, ...rest] = matches
  return { ok: true, typeID: best.typeID, name: best.name, alsoMatched: rest.slice(0, 4).map((m) => m.name) }
}

// The industry material-efficiency modifiers exposed on the blueprint tools,
// mapped to eve-industry's cost() parameters. Kept LLM-friendly (levels and
// named tiers) rather than raw multipliers.
const MODIFIER_SHAPE = {
  runs: z.number().int().min(1).max(100000).optional().describe('Number of blueprint runs (default 1)'),
  material_efficiency: z
    .number()
    .int()
    .min(0)
    .max(10)
    .optional()
    .describe('Blueprint material efficiency level, 0–10 (default 0)'),
  structure: z
    .enum(['none', 'engineering_complex'])
    .optional()
    .describe(
      'Structure role bonus: engineering_complex gives 1% material reduction (default none). Ignored when structure_id is given.'
    ),
  rig: z
    .enum(['none', 't1', 't2'])
    .optional()
    .describe(
      'Material-efficiency rig fitted: t1 = 2%, t2 = 2.4% base reduction (default none). Ignored when structure_id is given.'
    ),
  security: z
    .enum(['highsec', 'lowsec', 'nullsec'])
    .optional()
    .describe(
      'System security, which scales the rig bonus: highsec ×1, lowsec ×1.9, null/wormhole ×2.1 (default highsec). Ignored when structure_id is given.'
    ),
  structure_id: z
    .string()
    .optional()
    .describe(
      'Id of one of your monitored Upwell structures (e.g. "1050603051889"). When set, its hull role bonus, fitted material-efficiency rig, and system security are derived automatically and OVERRIDE the structure/rig/security fields above (blueprint ME still comes from material_efficiency).'
    ),
}

type ModifierArgs = {
  runs?: number
  material_efficiency?: number
  structure?: 'none' | 'engineering_complex'
  rig?: 'none' | 't1' | 't2'
  security?: 'highsec' | 'lowsec' | 'nullsec'
  structure_id?: string
}

// The three material-reduction bonuses eve-industry's cost() takes, already
// mapped to its literal-union types. The casts are safe: the enum-backed
// inputs (and the structure resolver) only ever produce valid members.
type Bonuses = { structure: StructureBonus; rig: RigBonus; sec: SecBonus }

const manualBonuses = (m: ModifierArgs): Bonuses => ({
  structure: (m.structure === 'engineering_complex' ? 0.01 : 0) as StructureBonus,
  rig: (m.rig === 't2' ? 0.024 : m.rig === 't1' ? 0.02 : 0) as RigBonus,
  sec: (m.security === 'nullsec' ? 2.1 : m.security === 'lowsec' ? 1.9 : 1) as SecBonus,
})

// eve-industry cost() params: material reduction is
//   runs * base * (1 - ME) * (1 - structure) * (1 - rig*sec).
const toCostParams = (m: ModifierArgs, bonuses: Bonuses): Omit<ModifierParams, 'base'> => ({
  runs: m.runs ?? 1,
  blueprint: ((m.material_efficiency ?? 0) / 100) as BlueprintME,
  ...bonuses,
})

// EVE Upwell structure hull groups (stable SDE group ids). Engineering
// complexes carry a 1% manufacturing material role bonus; refineries a 1%
// reaction material role bonus. Citadels give neither.
const ENGINEERING_COMPLEX_GROUP = 1404
const REFINERY_GROUP = 1406

// Round the raw SDE security to EVE's displayed band → the rig security
// multiplier eve-industry expects (highsec ×1, lowsec ×1.9, null/WH ×2.1).
const securityMultiplier = (rawSecurity: number | null): { sec: SecBonus; band: string } => {
  if (rawSecurity == null) return { sec: 2.1, band: 'nullsec/wormhole' } // WH & unknown systems aren't in the SDE k-space set
  const rounded = Math.round(rawSecurity * 10) / 10
  if (rounded >= 0.5) return { sec: 1, band: 'highsec' }
  if (rounded > 0) return { sec: 1.9, band: 'lowsec' }
  return { sec: 2.1, band: 'nullsec' }
}

// Tier of a Standup material-efficiency rig from its name: the "… II" variant
// is T2 (2.4% base), the "… I" variant T1 (2.0%).
const rigBonusFromName = (name: string): RigBonus => (/\bII$/.test(name.trim()) ? 0.024 : 0.02)

// The product a bill is being computed for. A rig only discounts a build whose
// product falls in the group/category the rig's filter covers, so applicability
// is decided per product, not per structure.
export type ProductRef = { groupID: number; categoryID: number } | null

// One monitored structure's fixed facts, loaded once per tool call: the hull
// (whose group decides the role bonus), the system security that scales rigs,
// and every material-efficiency rig fitted. Which of those rigs actually
// applies varies per product, so the list is kept whole here and filtered later.
type StructureContext = {
  name: string
  hullName: string
  hullGroup: number | undefined
  systemName: string | null
  securityBand: string
  sec: SecBonus
  meRigs: Array<{ typeID: number; name: string; bonus: RigBonus }>
}

type StructureLoad = { ok: true; ctx: StructureContext } | { ok: false; message: string }

// Load a structure the caller monitors. RLS on corp_structure /
// corp_structure_rig scopes the lookup to structures they can actually see, so
// an id they don't monitor simply reads as "not found".
const loadStructure = async (supabase: SupabaseClient, structureId: string): Promise<StructureLoad> => {
  const { data: structure } = await supabase
    .from('corp_structure')
    .select('structure_id, type_id, system_id, name')
    .eq('structure_id', structureId)
    .maybeSingle()
  if (!structure) {
    return { ok: false, message: `Structure ${structureId} isn't among the structures you monitor (corp_structure).` }
  }

  const { data: rigRows } = await supabase.from('corp_structure_rig').select('type_id').eq('structure_id', structureId)
  const rigTypeIds = ((rigRows ?? []) as Array<{ type_id: number | string }>).map((r) => Number(r.type_id))

  const hullType = await getSdeType(Number(structure.type_id))
  const system = await getSdeSystem(Number(structure.system_id))
  const { sec, band } = securityMultiplier(system?.security ?? null)

  const rigNames = await getSdeTypeNames(rigTypeIds)
  const meRigs = rigTypeIds
    .filter((id) => typeof rigNames[id] === 'string' && /Material Efficiency/i.test(rigNames[id]))
    .map((id) => ({ typeID: id, name: rigNames[id], bonus: rigBonusFromName(rigNames[id]) }))

  return {
    ok: true,
    ctx: {
      name: (structure.name as string) ?? `Structure #${structureId}`,
      hullName: hullType?.name ?? `Type #${structure.type_id}`,
      hullGroup: hullType?.groupID,
      systemName: system?.name ?? null,
      securityBand: band,
      sec,
      meRigs,
    },
  }
}

// The bonuses this structure gives one specific build. The rig is chosen from
// only those fitted rigs whose filter covers the product's group/category
// (a Standup Ship Manufacturing rig must not discount a component build), and
// the ones skipped for that reason are reported so the caller can see why the
// number is lower than the rig list suggests.
const structureBonusesFor = (
  ctx: StructureContext,
  activityID: number,
  product: ProductRef
): { bonuses: Bonuses; resolved: Record<string, unknown> } => {
  const roleApplies =
    (ctx.hullGroup === ENGINEERING_COMPLEX_GROUP && activityID === MANUFACTURING) ||
    (ctx.hullGroup === REFINERY_GROUP && activityID === REACTION)

  const applicable = product
    ? ctx.meRigs.filter((r) => rigAppliesToProduct(r.typeID, product.groupID, product.categoryID))
    : ctx.meRigs
  const applicableIds = new Set(applicable.map((r) => r.typeID))
  const skipped = ctx.meRigs.filter((r) => !applicableIds.has(r.typeID))
  const best = [...applicable].sort((a, b) => b.bonus - a.bonus)[0]

  return {
    bonuses: {
      structure: (roleApplies ? 0.01 : 0) as StructureBonus,
      rig: (best?.bonus ?? 0) as RigBonus,
      sec: ctx.sec,
    },
    resolved: {
      structure: ctx.name,
      system: ctx.systemName,
      security_band: ctx.securityBand,
      hull: ctx.hullName,
      role_bonus_applies: roleApplies,
      rig: best?.name ?? null,
      ...(skipped.length > 0 && {
        rigs_not_applicable: skipped.map((r) => r.name),
        rig_note: `${skipped.length} fitted ME rig(s) don't cover this product's group and were ignored.`,
      }),
      ...(applicable.length > 1 && {
        rig_note: `Multiple applicable ME rigs fitted; used the strongest. All: ${applicable
          .map((r) => r.name)
          .join(', ')}.`,
      }),
      ...(product == null &&
        ctx.meRigs.length > 0 && { rig_note: "Product unknown, so rig applicability wasn't checked." }),
    },
  }
}

// Resolve the effective bonuses for a build, honoring structure_id (which
// overrides the manual structure/rig/security fields) when present. The
// structure is loaded once; the returned resolver is called per (activity,
// product) pair, since a listing tool prices many different products against
// the same structure.
type ModifierResolver = (
  activityID: number,
  product: ProductRef
) => { costParams: Omit<ModifierParams, 'base'>; echo: Record<string, unknown> }

// `resolve` answers one product; `summary` describes the inputs that hold
// across every product (for a listing tool, where naming a single rig at the
// top level would be a lie — each row reports the rig actually applied to it).
type BuiltModifiers =
  { ok: true; resolve: ModifierResolver; summary: Record<string, unknown> } | { ok: false; message: string }

const buildModifiers = async (m: ModifierArgs, extra: { authInfo?: AuthInfo }): Promise<BuiltModifiers> => {
  const base = {
    runs: m.runs ?? 1,
    material_efficiency: m.material_efficiency ?? 0,
  }
  if (m.structure_id) {
    const supabase = clientFor(extra)
    if (!supabase) return { ok: false, message: 'Missing bearer token.' }
    const loaded = await loadStructure(supabase, m.structure_id)
    if (!loaded.ok) return loaded
    const { ctx } = loaded
    return {
      ok: true,
      resolve: (activityID, product) => {
        const { bonuses, resolved } = structureBonusesFor(ctx, activityID, product)
        return { costParams: toCostParams(m, bonuses), echo: { ...base, from_structure: resolved } }
      },
      summary: {
        ...base,
        from_structure: {
          structure: ctx.name,
          system: ctx.systemName,
          security_band: ctx.securityBand,
          hull: ctx.hullName,
          me_rigs_fitted: ctx.meRigs.map((r) => r.name),
          rig: 'varies by product — see rig_applied on each row',
        },
      },
    }
  }
  const costParams = toCostParams(m, manualBonuses(m))
  const echo = {
    ...base,
    structure: m.structure ?? 'none',
    rig: m.rig ?? 'none',
    security: m.security ?? 'highsec',
  }
  return { ok: true, resolve: () => ({ costParams, echo }), summary: echo }
}

// Apply resolved cost params to a blueprint's per-run material bill, returning
// base and adjusted quantities side by side. cost() preserves input order, so
// the returned array zips back onto the materials.
const modifiedMaterials = (bp: Blueprint, costParams: Omit<ModifierParams, 'base'>, names: Record<number, string>) => {
  const required = cost({ base: bp.materials.map((mat) => mat.quantity), ...costParams })
  return bp.materials.map((mat, i) => ({
    material: names[mat.typeID] ?? `Type #${mat.typeID}`,
    quantity_per_run: mat.quantity,
    quantity_required: required[i],
  }))
}

const activityName = (activityID: number): string => ACTIVITY_NAMES[activityID] ?? `Activity #${activityID}`

export const registerTools = (server: McpServer): void => {
  server.registerTool(
    'search_assets',
    {
      title: 'Search assets',
      description:
        'Find items across all of the user\'s character and corporation hangars by item name. Answers questions like "where is my Avatar" or "how many fuel blocks do I have in EKPB-3". The item name is a case-insensitive substring match against EVE item types; optionally narrow to one solar system. Blueprints are excluded unless include_blueprints is set (use list_blueprints for those).',
      inputSchema: {
        item: z.string().min(1).describe('Item name or substring, e.g. "nitrogen fuel block", "avatar", "tritanium"'),
        system: z.string().optional().describe('Only include items in this solar system, e.g. "EKPB-3"'),
        include_blueprints: z.boolean().optional().describe('Also match blueprints/reaction formulas (default false)'),
      },
    },
    async ({ item, system, include_blueprints }, extra) => {
      const supabase = clientFor(extra)
      if (!supabase) return textResult('Missing bearer token.')

      const filter = await resolveTypeFilter(item, { includeBlueprints: include_blueprints ?? false })
      if (!filter.ok) return textResult(filter.message)
      if (!filter.matches) return textResult('Provide an item name to search for.')

      const typeIds = filter.matches.map((m) => m.typeID)
      const typeNameById = new Map(filter.matches.map((m) => [m.typeID, m.name]))

      const [{ data: characterRows }, { data: corpRows }, owners] = await Promise.all([
        supabase.rpc('character_asset_search', { type_ids: typeIds }),
        supabase.rpc('corp_asset_search', { type_ids: typeIds }),
        fetchOwnerContext(supabase),
      ])

      type CharacterSearchRow = {
        item_id: number | string
        character_id: string
        type_id: number | string
        quantity: number | string | null
        is_singleton: boolean | null
        name: string | null
        location_flag: string | null
        root_location_id: number | string | null
        root_location_type: string | null
        contents: number | string
      }
      type CorpSearchRow = Omit<CharacterSearchRow, 'character_id' | 'name'> & { corporation_id: number | string }

      const rows = [
        ...((characterRows ?? []) as CharacterSearchRow[]).map((r) => ({ ...r, ownerId: r.character_id })),
        ...((corpRows ?? []) as CorpSearchRow[]).map((r) => ({ ...r, name: null, ownerId: String(r.corporation_id) })),
      ].map((r) => ({
        ownerId: r.ownerId,
        typeId: Number(r.type_id),
        customName: r.name,
        // Singletons (assembled ships, containers, …) report a null/1 quantity.
        quantity: r.is_singleton ? 1 : Number(r.quantity ?? 1),
        flag: r.location_flag,
        root:
          r.root_location_id != null
            ? ({ id: String(r.root_location_id), type: r.root_location_type } as LocationRef)
            : null,
        contents: Number(r.contents),
      }))

      const rootRefs = uniqBy(
        prop('id'),
        rows.map((r) => r.root).filter((r): r is LocationRef => r != null)
      )
      const { nameFor, systemFor } = await resolveLocations(rootRefs, supabase)

      // Canonicalize a partial system filter through the SDE search so
      // "ekpb" still matches items sitting in EKPB-3.
      const systemMatch = system?.trim() ? ((await searchSdeSystems(system, 1))[0]?.name ?? system.trim()) : null
      const systemFilter = systemMatch != null ? systemMatch.toLowerCase() : null

      const located = rows
        .map((row) => {
          const floating = row.root?.type === 'solar_system'
          const stationName = row.root && !floating ? nameFor(row.root) : null
          const systemName = row.root ? (systemFor(row.root) ?? (floating ? nameFor(row.root) : null)) : null
          return { row, stationName, systemName }
        })
        .filter(({ systemName }) => systemFilter == null || (systemName ?? '').toLowerCase() === systemFilter)
        .sort(
          (a, b) =>
            (a.systemName ?? '').localeCompare(b.systemName ?? '') ||
            (a.stationName ?? '').localeCompare(b.stationName ?? '') ||
            (typeNameById.get(a.row.typeId) ?? '').localeCompare(typeNameById.get(b.row.typeId) ?? '')
        )

      const totalsByItem: Record<string, number> = {}
      located.forEach(({ row }) => {
        const name = typeNameById.get(row.typeId) ?? `Type #${row.typeId}`
        totalsByItem[name] = (totalsByItem[name] ?? 0) + row.quantity
      })

      const shown = located.slice(0, MAX_ROWS)
      return textResult({
        query: item,
        matched_types: typeIds.length,
        ...(systemFilter != null && { system_filter: shown[0]?.systemName ?? system }),
        total_stacks: located.length,
        totals_by_item: totalsByItem,
        items: shown.map(({ row, stationName, systemName }) => ({
          item: typeNameById.get(row.typeId) ?? `Type #${row.typeId}`,
          quantity: row.quantity,
          owner: owners.nameById.get(row.ownerId) ?? row.ownerId,
          system: systemName,
          station: stationName,
          hangar: row.flag,
          ...(row.customName != null && { custom_name: row.customName }),
          ...(row.contents > 0 && { contains_items: row.contents }),
        })),
        ...(capNote(located.length, shown.length, 'stacks') && {
          note: capNote(located.length, shown.length, 'stacks'),
        }),
        data_refreshed: await dataFreshness(supabase, ['character-assets', 'corp-assets']),
      })
    }
  )

  server.registerTool(
    'list_clones',
    {
      title: 'List clones',
      description:
        'The user\'s characters with their current location, the ship they\'re currently in, active implants, jump-clone locations (each with its implants), and when each character can next clone jump. Answers questions like "where is my nearest clone to Jita", "what am I flying", or "which clone has my Genolution set".',
      inputSchema: {},
    },
    async (_args, extra) => {
      const supabase = clientFor(extra)
      if (!supabase) return textResult('Missing bearer token.')

      const [
        { data: cloneRows },
        { data: implantRows },
        { data: locationRows },
        { data: stateRows },
        { data: shipRows },
        owners,
      ] = await Promise.all([
        supabase
          .from('character_clone')
          .select('character_id, jump_clone_id, is_home, location_id, location_type, name, implants, system_id'),
        supabase.from('character_implant').select('character_id, type_ids'),
        supabase.from('character_location').select('character_id, solar_system_id, station_id, structure_id'),
        supabase.from('character_clone_state').select('character_id, last_clone_jump_date'),
        supabase.from('character_ship').select('character_id, ship_item_id, ship_type_id, ship_name'),
        fetchOwnerContext(supabase),
      ])

      type CloneRow = {
        character_id: string
        jump_clone_id: number | string | null
        is_home: boolean
        location_id: number | string
        location_type: string | null
        name: string | null
        implants: number[]
        system_id: number | string | null
      }
      type LocationRow = {
        character_id: string
        solar_system_id: number | string
        station_id: number | string | null
        structure_id: number | string | null
      }
      const clones = (cloneRows ?? []) as CloneRow[]
      const locations = (locationRows ?? []) as LocationRow[]

      // Clone rows carry their own location type; a character's current
      // docking spot needs the NPC-station/structure split from the columns.
      const cloneRefs = clones.map((c): LocationRef => ({ id: String(c.location_id), type: c.location_type }))
      const dockedRefs = locations.flatMap((l): LocationRef[] => [
        ...(l.station_id != null ? [{ id: String(l.station_id), type: 'station' }] : []),
        ...(l.structure_id != null ? [{ id: String(l.structure_id), type: null }] : []),
      ])
      const { nameFor } = await resolveLocations(uniqBy(prop('id'), [...cloneRefs, ...dockedRefs]), supabase)

      const systemIds = [
        ...clones.flatMap((c) => (c.system_id != null ? [Number(c.system_id)] : [])),
        ...locations.map((l) => Number(l.solar_system_id)),
      ]
      const systemNames = await resolveSystemNames(supabase, systemIds)

      type ShipRow = {
        character_id: string
        ship_item_id: number | string
        ship_type_id: number | string
        ship_name: string | null
      }
      const ships = (shipRows ?? []) as ShipRow[]

      // One bulk SDE lookup covers implants (clone + active) and hulls.
      const implantTypeIds = [
        ...clones.flatMap((c) => c.implants ?? []),
        ...((implantRows ?? []) as Array<{ type_ids: number[] }>).flatMap((r) => r.type_ids ?? []),
      ].map(Number)
      const implantNames = await getSdeTypeNames([...implantTypeIds, ...ships.map((s) => Number(s.ship_type_id))])

      const implantsByCharacter = new Map(
        ((implantRows ?? []) as Array<{ character_id: string; type_ids: number[] }>).map((r) => [
          r.character_id,
          (r.type_ids ?? []).map((id) => typeName(implantNames, id)),
        ])
      )
      const jumpByCharacter = new Map(
        ((stateRows ?? []) as Array<{ character_id: string; last_clone_jump_date: string | null }>).map((r) => [
          r.character_id,
          r.last_clone_jump_date,
        ])
      )
      const locationByCharacter = new Map(locations.map((l) => [l.character_id, l]))
      // The hull the character is sitting in right now, docked or not — named
      // by its player-assigned name plus type when they differ (cf. /character).
      const shipByCharacter = new Map(
        ships.map((s) => {
          const hull = typeName(implantNames, s.ship_type_id)
          return [
            s.character_id,
            {
              item_id: String(s.ship_item_id),
              ship: s.ship_name && s.ship_name !== hull ? `${s.ship_name} (${hull})` : hull,
            },
          ]
        })
      )

      const characters = owners.characterIds.map((characterId) => {
        const location = locationByCharacter.get(characterId)
        const dockedId = location?.station_id ?? location?.structure_id
        const lastJump = jumpByCharacter.get(characterId)
        // Clone jump cooldown is 24h from the last jump (skill-modified
        // cooldowns aren't tracked, so this is the conservative upper bound).
        const nextJump = lastJump ? new Date(new Date(lastJump).getTime() + 24 * 60 * 60 * 1000).toISOString() : null
        return {
          character: owners.nameById.get(characterId) ?? characterId,
          current_location: location
            ? {
                system: systemNames[Number(location.solar_system_id)] ?? `System #${location.solar_system_id}`,
                docked_at:
                  dockedId != null
                    ? nameFor({ id: String(dockedId), type: location.station_id != null ? 'station' : null })
                    : null,
              }
            : null,
          current_ship: shipByCharacter.get(characterId) ?? null,
          active_implants: implantsByCharacter.get(characterId) ?? [],
          next_clone_jump_available_at: nextJump,
          clones: clones
            .filter((c) => c.character_id === characterId)
            .map((c) => ({
              home: c.is_home,
              ...(c.name != null && { name: c.name }),
              system: c.system_id != null ? (systemNames[Number(c.system_id)] ?? `System #${c.system_id}`) : null,
              location: nameFor({ id: String(c.location_id), type: c.location_type }),
              implants: (c.implants ?? []).map((id) => typeName(implantNames, id)),
            })),
        }
      })

      return textResult({
        characters,
        // Clones, implants, and location are all refreshed by the combined
        // character-status job now (src/jobs/characterStatus.js).
        data_refreshed: await dataFreshness(supabase, ['character-status']),
      })
    }
  )

  server.registerTool(
    'list_blueprints',
    {
      title: 'List blueprints',
      description:
        'The user\'s character- and corporation-owned blueprints with ME/TE research levels, remaining runs (for copies), and location. Filter by name — searching by product works too ("naglfar" matches "Naglfar Blueprint") — by owner, by solar system or structure, by original vs copy, and by research level. NOTE: below_me and below_te are OR\'d when both are given, i.e. "short of either target", which is how "which blueprints are not at ME/TE 10/20 yet" is actually asked. Set researchable to exclude reaction formulas, which can never be researched and otherwise flood any research-backlog result at 0/0. Set group to "type" to collapse identical (blueprint, ME, TE) stacks into one counted row, or "type_location" to keep those split per location.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        item: z.string().optional().describe('Blueprint (or product) name substring, e.g. "naglfar", "fuel block"'),
        owner: z
          .string()
          .optional()
          .describe('Only blueprints owned by this character or corporation (name substring)'),
        system: z
          .string()
          .optional()
          .describe(
            'Only blueprints in this solar system, e.g. "27-HP0". Blueprints stowed inside a container or ship resolve to no system and are excluded when this is set.'
          ),
        structure: z
          .string()
          .optional()
          .describe(
            'Only blueprints in this structure (substring of its resolved name, e.g. "HDUMP - T1 Research"). Matches blueprints sitting directly in the structure; ones inside a container within it are not matched.'
          ),
        kind: z
          .enum(['original', 'copy', 'all'])
          .optional()
          .describe('Originals (BPOs), copies (BPCs), or both (default "all")'),
        below_me: z
          .number()
          .int()
          .min(0)
          .max(10)
          .optional()
          .describe('Only blueprints whose material efficiency is BELOW this level, e.g. 10 for "not yet ME 10"'),
        below_te: z
          .number()
          .int()
          .min(0)
          .max(20)
          .optional()
          .describe(
            "Only blueprints whose time efficiency is BELOW this level. When below_me is also given the two are OR'd: rows short of EITHER target are returned."
          ),
        researchable: z
          .boolean()
          .optional()
          .describe(
            'Exclude types that cannot be researched at all (reaction formulas). They permanently report ME/TE 0/0, so leaving them in floods any "still needs research" question.'
          ),
        group: z
          .enum(['none', 'type', 'type_location'])
          .optional()
          .describe(
            'How to group: "none" (default) lists every stack; "type" collapses identical (blueprint, ME, TE) stacks into one row with a count; "type_location" does the same but keeps locations apart'
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_BLUEPRINT_LIMIT)
          .optional()
          .describe(
            `Maximum rows to itemize (default ${DEFAULT_BLUEPRINT_LIMIT}, max ${MAX_BLUEPRINT_LIMIT}). Totals always cover the whole filtered set.`
          ),
      },
    },
    async ({ item, owner, system, structure, kind, below_me, below_te, researchable, group, limit }, extra) => {
      const supabase = clientFor(extra)
      if (!supabase) return textResult('Missing bearer token.')

      const filter = await resolveTypeFilter(item)
      if (!filter.ok) return textResult(filter.message)
      const typeIds = filter.matches?.map((m) => m.typeID) ?? null

      const owners = await fetchOwnerContext(supabase)
      const ownerFilter = resolveOwnerFilter(owner, owners)
      if (!ownerFilter.ok) return textResult(ownerFilter.message)

      const systemMatch = await resolveOneSystem(system)
      if (!systemMatch.ok) return textResult(systemMatch.message)

      // A structure name resolves through universe_structure to the ids a
      // blueprint's location_id can carry, so the filter itself stays in SQL.
      const structureMatch = await resolveStructures(supabase, structure)
      if (!structureMatch.ok) return textResult(structureMatch.message)

      // Every filter, the character/corp union, the collapse and the limit
      // happen inside blueprint_search(); the totals it returns cover the whole
      // filtered set, so only the capped rows cross the wire.
      const params = buildBlueprintParams(
        {
          typeIds,
          systemIds: systemMatch.system ? [systemMatch.system.systemID] : null,
          structureIds: structureMatch.structureIds,
          ownerIds: ownerFilter.ownerIds,
          kind,
          belowMe: below_me,
          belowTe: below_te,
          researchable,
          group,
          limit,
        },
        owners
      )

      const { data, error } = await supabase.rpc('blueprint_search', params)
      if (error) return textResult(`Blueprint lookup failed: ${error.message}`)
      const payload = (data ?? EMPTY_BLUEPRINT_PAYLOAD) as BlueprintSearchPayload

      // Only the capped rows need location/system display names.
      const shownRows = payload.rows as Array<{ location_id: number | null; system_id: number | null }>
      const locationRefs = uniqBy(
        prop('id'),
        shownRows.map((r) => guessLocationRef(r.location_id)).filter((r): r is LocationRef => r != null)
      )
      const [{ nameFor }, systemNames] = await Promise.all([
        resolveLocations(locationRefs, supabase),
        resolveSystemNames(
          supabase,
          shownRows.flatMap((r) => (r.system_id != null ? [Number(r.system_id)] : []))
        ),
      ])

      const { rows, total, unit } = formatBlueprintRows(payload, {
        ownerName: (ownerId) => owners.nameById.get(ownerId) ?? ownerId,
        systemName: (systemId) => systemNames[systemId] ?? null,
        locationName: (row) => {
          const ref = guessLocationRef(row.location_id)
          return ref ? nameFor(ref) : row.location_name
        },
      })

      const applied = {
        ...(item != null && { item }),
        ...(owner != null && { owner }),
        ...(systemMatch.system && { system: systemMatch.system.name }),
        ...(structureMatch.name != null && { structure: structureMatch.name }),
        ...(kind != null && { kind }),
        ...(below_me != null && { below_me }),
        ...(below_te != null && { below_te }),
        ...(researchable === true && { researchable }),
        ...(group != null && { group }),
      }

      return textResult({
        filters: applied,
        group: payload.group,
        total_blueprints: payload.total_stacks,
        total_quantity: payload.total_quantity,
        originals: payload.originals,
        copies: payload.copies,
        distinct_types: payload.distinct_types,
        ...(payload.total_groups != null && { total_groups: payload.total_groups }),
        blueprints: rows,
        ...(truncationNote(total, rows.length, unit, applied, params.row_limit) && {
          note: truncationNote(total, rows.length, unit, applied, params.row_limit),
        }),
        data_refreshed: await dataFreshness(supabase, ['character-blueprints', 'corp-blueprints']),
      })
    }
  )

  server.registerTool(
    'list_structures',
    {
      title: 'List structures',
      description:
        'The Upwell structures the user\'s corporations own and monitor — hull type, solar system, state, fuel expiry, online services, fitted rigs, and the derived material-efficiency bonus. Answers "which structures are in 27-HP0", "what runs out of fuel this week", or "where should I build this". Each row\'s structure_id is what blueprint_for_product takes as structure_id, so this explains why a material requirement came out at 18 instead of 20 — but me_bonus is a best case: its rig half assumes the fitted ME rig covers whatever you are building. A rig only bonuses products in the groups its filter covers, so blueprint_for_product (and rigs_for_blueprint) apply that per-product test and may come out lower.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        system: z.string().optional().describe('Only structures in this solar system, e.g. "27-HP0"'),
        name: z.string().optional().describe('Only structures whose name contains this substring, e.g. "T1 Research"'),
        owner: z.string().optional().describe('Only structures owned by this corporation (name substring)'),
        services: z
          .array(z.string())
          .optional()
          .describe(
            'Only structures with all of these services online (case-insensitive substrings, e.g. ["manufacturing"])'
          ),
      },
    },
    async ({ system, name, owner, services }, extra) => {
      const supabase = clientFor(extra)
      if (!supabase) return textResult('Missing bearer token.')

      const owners = await fetchOwnerContext(supabase)
      const ownerFilter = resolveOwnerFilter(owner, owners)
      if (!ownerFilter.ok) return textResult(ownerFilter.message)

      const systemMatch = await resolveOneSystem(system)
      if (!systemMatch.ok) return textResult(systemMatch.message)

      const COLUMNS =
        'structure_id, corporation_id, type_id, system_id, name, state, unanchors_at, services, last_seen_at'
      const found = await fetchAllRows<StructureRow>((from, to) => {
        // Cast rather than assigned: structurally checking PostgrestFilterBuilder's
        // generic signatures against FilterableQuery's narrow ones tips tsc past
        // its instantiation-depth limit (TS2589).
        const base = supabase.from('corp_structure').select(COLUMNS) as unknown as FilterableQuery
        return applyStructureFilters(base, {
          systemId: systemMatch.system?.systemID ?? null,
          name,
          corporationIds: corporationIdsFor(ownerFilter.ownerIds, owners.corporationIds),
        })
          .order('system_id')
          .order('structure_id')
          .range(from, to)
      })
      const rows = found.filter((s) => matchesServices(s, services))

      const structureIds = rows.map((s) => String(s.structure_id))
      const [{ data: statusRows }, { data: rigRows }] = structureIds.length
        ? await Promise.all([
            supabase
              .from('corp_structure_status')
              .select('structure_id, fuel_expires')
              .in('structure_id', structureIds),
            supabase.from('corp_structure_rig').select('structure_id, type_id').in('structure_id', structureIds),
          ])
        : [{ data: [] }, { data: [] }]

      const fuelByStructure = new Map(
        ((statusRows ?? []) as Array<{ structure_id: number | string; fuel_expires: string | null }>).map((r) => [
          String(r.structure_id),
          r.fuel_expires,
        ])
      )
      const rigTypeIdsByStructure = (
        (rigRows ?? []) as Array<{ structure_id: number | string; type_id: number | string }>
      ).reduce((acc, r) => {
        const key = String(r.structure_id)
        acc.set(key, [...(acc.get(key) ?? []), Number(r.type_id)])
        return acc
      }, new Map<string, number[]>())

      const hullTypes = await getSdeTypes(rows.map((s) => Number(s.type_id)))
      const rigNames = await getSdeTypeNames([...rigTypeIdsByStructure.values()].flat())
      const systems = await getSdeSystems(rows.map((s) => Number(s.system_id)))
      const systemNames = await resolveSystemNames(
        supabase,
        rows.map((s) => Number(s.system_id))
      )

      const shown = rows.slice(0, MAX_ROWS).map((row) =>
        formatStructure(row, {
          ownerName: (corporationId) => owners.nameById.get(corporationId) ?? `Corporation #${corporationId}`,
          hullName: (typeId) => hullTypes[typeId]?.name ?? `Type #${typeId}`,
          hullGroupId: (typeId) => hullTypes[typeId]?.groupID ?? null,
          systemName: (systemId) => systemNames[systemId] ?? null,
          security: (systemId) => {
            const security = systems[systemId]?.security ?? null
            const { sec, band } = securityMultiplier(security)
            return { multiplier: sec, band, display: security != null ? formatSecurity(security) : null }
          },
          fuelExpires: (structureId) => fuelByStructure.get(structureId) ?? null,
          rigs: (structureId) =>
            (rigTypeIdsByStructure.get(structureId) ?? []).map((id) => rigNames[id] ?? `Type #${id}`),
        })
      )

      return textResult({
        filters: {
          ...(systemMatch.system && { system: systemMatch.system.name }),
          ...(name != null && { name }),
          ...(owner != null && { owner }),
          ...(services != null && services.length > 0 && { services }),
        },
        total_structures: rows.length,
        structures: shown,
        ...(capNote(rows.length, shown.length, 'structures') && {
          note: capNote(rows.length, shown.length, 'structures'),
        }),
        data_refreshed: await dataFreshness(supabase, ['corp-structures']),
      })
    }
  )
  server.registerTool(
    'list_industry_jobs',
    {
      title: 'List industry jobs',
      description:
        'Manufacturing, research, invention, copying, and reaction jobs across the user\'s characters and corporations. Defaults to active jobs; pass a status ("ready", "delivered", …) or "all" for history. Answers "what\'s building right now" or "when does my research finish". Pass as_of to see the jobs as they stood at a past moment (e.g. what was running last Tuesday).',
      inputSchema: {
        status: z
          .enum(['active', 'ready', 'paused', 'delivered', 'cancelled', 'reverted', 'all'])
          .optional()
          .describe('Job status to show (default "active")'),
        owner: z.string().optional().describe('Only jobs for this character or corporation (name substring)'),
        as_of: AS_OF_SHAPE,
      },
    },
    async ({ status, owner, as_of }, extra) => {
      const supabase = clientFor(extra)
      if (!supabase) return textResult('Missing bearer token.')

      const owners = await fetchOwnerContext(supabase)
      const ownerFilter = resolveOwnerFilter(owner, owners)
      if (!ownerFilter.ok) return textResult(ownerFilter.message)

      const at = parseAtParam(as_of)
      if (!at.ok) return textResult(AT_PARAM_ERROR)
      const timeTravel = (as_of ?? '').trim() !== ''

      const wantedStatus = status ?? 'active'
      type JobRow = {
        job_id: number | string
        installer_id: number | string
        activity_id: number
        blueprint_type_id: number | string
        product_type_id: number | string | null
        runs: number
        cost: number | string | null
        probability: number | null
        status: string
        start_date: string
        end_date: string
        station_id: number | string | null
        facility_id: number | string | null
        successful_runs: number | null
      }
      const COLUMNS =
        'job_id, installer_id, activity_id, blueprint_type_id, product_type_id, runs, cost, probability, status, start_date, end_date, station_id, facility_id, successful_runs'
      // Owner-filtered character ids, so the character-side query (live or
      // historical) never fetches owners the caller filtered out. Corp rows
      // can't be pre-filtered this way — the corp function maps characters to
      // their corporations — so those are filtered by corporation_id below.
      const wantedCharacterIds =
        ownerFilter.ownerIds == null
          ? owners.characterIds
          : owners.characterIds.filter((id) => ownerFilter.ownerIds!.has(id))
      const corpWanted = (corporationId: number | string) =>
        ownerFilter.ownerIds == null || ownerFilter.ownerIds.has(String(corporationId))

      // Every job normalized to one shape, since the historical path returns
      // the owner's name where the live path returns an id to look up.
      type NormalizedJob = JobRow & { ownerLabel: string }

      let characterJobs: NormalizedJob[]
      let corpJobs: NormalizedJob[]

      if (timeTravel) {
        // The SCD-2 functions take include_delivered rather than a status, so
        // ask for the superset and narrow to the wanted status here.
        const includeDelivered = !['active', 'ready', 'paused'].includes(wantedStatus)
        const [{ data: chr, error: chrError }, { data: corp, error: corpError }] = await Promise.all([
          supabase.rpc('character_industry_jobs', {
            character_ids: wantedCharacterIds,
            include_delivered: includeDelivered,
            as_of: at.iso,
          }),
          supabase.rpc('corp_industry_jobs', {
            character_ids: owners.characterIds,
            include_delivered: includeDelivered,
            as_of: at.iso,
          }),
        ])
        const failure = chrError ?? corpError
        if (failure) return textResult(`Couldn't read the job history: ${failure.message}`)

        const ofWantedStatus = (row: { status: string }) => wantedStatus === 'all' || row.status === wantedStatus
        characterJobs = ((chr ?? []) as Array<JobRow & { character_name: string | null }>)
          .filter(ofWantedStatus)
          .map((j) => ({ ...j, ownerLabel: j.character_name ?? '—' }))
        corpJobs = ((corp ?? []) as Array<JobRow & { corporation_id: number | string }>)
          .filter((j) => ofWantedStatus(j) && corpWanted(j.corporation_id))
          .map((j) => ({ ...j, ownerLabel: owners.nameById.get(String(j.corporation_id)) ?? String(j.corporation_id) }))
      } else {
        const wantedCharacterIdSet = new Set(wantedCharacterIds)
        const [chr, corp] = await Promise.all([
          fetchAllRows<JobRow & { character_id: string }>((from, to) => {
            let q = supabase.from('character_industry_job').select(`${COLUMNS}, character_id`)
            if (wantedStatus !== 'all') q = q.eq('status', wantedStatus)
            return q.order('end_date', { ascending: true }).range(from, to)
          }),
          fetchAllRows<JobRow & { corporation_id: number | string }>((from, to) => {
            let q = supabase.from('corp_industry_job').select(`${COLUMNS}, corporation_id`)
            if (wantedStatus !== 'all') q = q.eq('status', wantedStatus)
            return q.order('end_date', { ascending: true }).range(from, to)
          }),
        ])
        characterJobs = chr
          .filter((j) => wantedCharacterIdSet.has(j.character_id))
          .map((j) => ({ ...j, ownerLabel: owners.nameById.get(j.character_id) ?? j.character_id }))
        corpJobs = corp
          .filter((j) => corpWanted(j.corporation_id))
          .map((j) => ({ ...j, ownerLabel: owners.nameById.get(String(j.corporation_id)) ?? String(j.corporation_id) }))
      }

      // A corp job installed by one of our own characters shows up in both
      // extracts under the same job_id; the corp row wins (cf. /industry).
      const corpJobIds = new Set(corpJobs.map((j) => String(j.job_id)))
      const rows = [...characterJobs.filter((j) => !corpJobIds.has(String(j.job_id))), ...corpJobs].sort(
        (a, b) => new Date(a.end_date).getTime() - new Date(b.end_date).getTime()
      )

      const typeNames = await getSdeTypeNames(
        rows.flatMap((j) => [
          Number(j.blueprint_type_id),
          ...(j.product_type_id != null ? [Number(j.product_type_id)] : []),
        ])
      )
      const locationRefs = uniqBy(
        prop('id'),
        rows.map((j) => guessLocationRef(j.station_id ?? j.facility_id)).filter((r): r is LocationRef => r != null)
      )
      const { nameFor } = await resolveLocations(locationRefs, supabase)

      // Installers are character ids (not registration uuids); the
      // universe_name cache resolves the ones it has seen.
      const installerIds = [...new Set(rows.map((j) => Number(j.installer_id)))]
      const { data: installerRows } = installerIds.length
        ? await supabase.from('universe_name').select('id, name').in('id', installerIds)
        : { data: [] }
      const installerNames = Object.fromEntries(
        ((installerRows ?? []) as Array<{ id: number | string; name: string }>).map((r) => [Number(r.id), r.name])
      )

      const shown = rows.slice(0, MAX_ROWS)
      return textResult({
        status: wantedStatus,
        ...(timeTravel && { as_of: at.iso }),
        total_jobs: rows.length,
        jobs: shown.map((j) => {
          const ref = guessLocationRef(j.station_id ?? j.facility_id)
          return {
            activity: ACTIVITY_NAMES[j.activity_id] ?? `Activity #${j.activity_id}`,
            blueprint: typeName(typeNames, j.blueprint_type_id),
            ...(j.product_type_id != null && { product: typeName(typeNames, j.product_type_id) }),
            runs: j.runs,
            status: j.status,
            start_date: j.start_date,
            end_date: j.end_date,
            owner: j.ownerLabel,
            ...(installerNames[Number(j.installer_id)] != null && {
              installer: installerNames[Number(j.installer_id)],
            }),
            location: ref ? nameFor(ref) : null,
            ...(j.cost != null && { cost: Number(j.cost) }),
            ...(j.probability != null && { probability: j.probability }),
            ...(j.successful_runs != null && { successful_runs: j.successful_runs }),
          }
        }),
        ...(capNote(rows.length, shown.length, 'jobs') && { note: capNote(rows.length, shown.length, 'jobs') }),
        data_refreshed: await dataFreshness(supabase, ['character-industry-jobs', 'corp-industry-jobs']),
      })
    }
  )

  server.registerTool(
    'list_market_orders',
    {
      title: 'List market orders',
      description:
        'The user\'s open market orders (buys and sells) across all characters, with price, remaining volume, location, and expiry. Answers "what am I selling" or "do I still have that buy order up". Pass as_of to see the orders that were open at some past moment instead — reconstructed from SCD-2 history, so a since-filled order reappears.',
      inputSchema: {
        item: z.string().optional().describe('Only orders for items matching this name substring'),
        as_of: AS_OF_SHAPE,
      },
    },
    async ({ item, as_of }, extra) => {
      const supabase = clientFor(extra)
      if (!supabase) return textResult('Missing bearer token.')

      const filter = await resolveTypeFilter(item)
      if (!filter.ok) return textResult(filter.message)
      const typeIds = filter.matches?.map((m) => m.typeID) ?? null

      const at = parseAtParam(as_of)
      if (!at.ok) return textResult(AT_PARAM_ERROR)
      const timeTravel = (as_of ?? '').trim() !== ''

      const owners = await fetchOwnerContext(supabase)

      // Live orders come from the is_current view; a past snapshot is rebuilt
      // by the character_orders() SCD-2 function, whose rows carry the owner's
      // name directly (and name is_buy differently). Both normalize to one shape.
      type NormalizedOrder = {
        typeId: number
        owner: string
        isBuy: boolean
        isCorporation: boolean
        price: number
        volumeRemain: number
        volumeTotal: number
        minVolume: number | null
        escrow: number | null
        locationId: number | string
        issued: string
        duration: number
      }

      let orders: NormalizedOrder[]
      if (timeTravel) {
        const { data, error } = await supabase.rpc('character_orders', {
          character_ids: owners.characterIds,
          as_of: at.iso,
        })
        if (error) return textResult(`Couldn't read the order history: ${error.message}`)
        type SnapshotRow = {
          type_id: number | string
          character_name: string | null
          is_buy_order: boolean
          is_corporation: boolean
          price: number | string
          volume_remain: number | string
          volume_total: number | string
          min_volume: number | string | null
          escrow: number | string | null
          location_id: number | string
          issued: string
          duration: number
        }
        orders = ((data ?? []) as SnapshotRow[])
          .filter((o) => typeIds == null || typeIds.includes(Number(o.type_id)))
          .map((o) => ({
            typeId: Number(o.type_id),
            owner: o.character_name ?? '—',
            isBuy: o.is_buy_order,
            isCorporation: o.is_corporation,
            price: Number(o.price),
            volumeRemain: Number(o.volume_remain),
            volumeTotal: Number(o.volume_total),
            minVolume: o.min_volume == null ? null : Number(o.min_volume),
            escrow: o.escrow == null ? null : Number(o.escrow),
            locationId: o.location_id,
            issued: o.issued,
            duration: o.duration,
          }))
      } else {
        type OrderRow = {
          order_id: number | string
          character_id: string
          type_id: number | string
          location_id: number | string
          is_buy: boolean
          is_corporation: boolean
          price: number | string
          volume_total: number | string
          volume_remain: number | string
          min_volume: number | string | null
          escrow: number | string | null
          duration: number
          issued: string
        }
        const rows = await fetchAllRows<OrderRow>((from, to) => {
          const q = supabase
            .from('character_order')
            .select(
              'order_id, character_id, type_id, location_id, is_buy, is_corporation, price, volume_total, volume_remain, min_volume, escrow, duration, issued'
            )
            .order('issued', { ascending: false })
            .range(from, to)
          return typeIds ? q.in('type_id', typeIds) : q
        })
        orders = rows.map((o) => ({
          typeId: Number(o.type_id),
          owner: owners.nameById.get(o.character_id) ?? o.character_id,
          isBuy: o.is_buy,
          isCorporation: o.is_corporation,
          price: Number(o.price),
          volumeRemain: Number(o.volume_remain),
          volumeTotal: Number(o.volume_total),
          minVolume: o.min_volume == null ? null : Number(o.min_volume),
          escrow: o.escrow == null ? null : Number(o.escrow),
          locationId: o.location_id,
          issued: o.issued,
          duration: o.duration,
        }))
      }

      const typeNames = await getSdeTypeNames(orders.map((o) => o.typeId))
      const locationRefs = uniqBy(
        prop('id'),
        orders.map((o) => guessLocationRef(o.locationId)).filter((r): r is LocationRef => r != null)
      )
      const { nameFor } = await resolveLocations(locationRefs, supabase)

      const sells = orders.filter((o) => !o.isBuy)
      const buys = orders.filter((o) => o.isBuy)
      const shown = orders.slice(0, MAX_ROWS)
      return textResult({
        ...(timeTravel && { as_of: at.iso }),
        total_orders: orders.length,
        sell_orders: sells.length,
        sell_value_remaining: sells.reduce((sum, o) => sum + o.price * o.volumeRemain, 0),
        buy_orders: buys.length,
        buy_escrow: buys.reduce((sum, o) => sum + (o.escrow ?? 0), 0),
        orders: shown.map((o) => {
          const ref = guessLocationRef(o.locationId)
          return {
            item: typeName(typeNames, o.typeId),
            side: o.isBuy ? 'buy' : 'sell',
            price: o.price,
            volume_remain: o.volumeRemain,
            volume_total: o.volumeTotal,
            owner: o.owner,
            ...(o.isCorporation && { corporation_order: true }),
            location: ref ? nameFor(ref) : null,
            issued: o.issued,
            expires: new Date(new Date(o.issued).getTime() + o.duration * 24 * 60 * 60 * 1000).toISOString(),
            ...(o.minVolume != null && o.minVolume > 1 && { min_volume: o.minVolume }),
          }
        }),
        ...(capNote(orders.length, shown.length, 'orders') && { note: capNote(orders.length, shown.length, 'orders') }),
        data_refreshed: await dataFreshness(supabase, ['character-orders']),
      })
    }
  )

  server.registerTool(
    'search_transactions',
    {
      title: 'Search market transactions',
      description:
        'Past market buys and sells across the user\'s characters and corporations (most recent first). Answers "what did I pay for PLEX last month" or "how much have I sold this week". Corp-division trades made by the user\'s characters are included once, under the corporation.',
      inputSchema: {
        item: z.string().optional().describe('Only trades of items matching this name substring'),
        days: z.number().int().min(1).max(365).optional().describe('Lookback window in days (default 30)'),
        side: z.enum(['buy', 'sell']).optional().describe('Only buys or only sells (default both)'),
        limit: z.number().int().min(1).max(500).optional().describe('Maximum rows to return (default 100)'),
      },
    },
    async ({ item, days, side, limit }, extra) => {
      const supabase = clientFor(extra)
      if (!supabase) return textResult('Missing bearer token.')

      const filter = await resolveTypeFilter(item)
      if (!filter.ok) return textResult(filter.message)
      const typeIds = filter.matches?.map((m) => m.typeID) ?? null

      const windowDays = days ?? 30
      const maxRows = limit ?? 100
      const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString()

      type TransactionRow = {
        transaction_id: number | string
        date: string
        type_id: number | string
        quantity: number | string
        unit_price: number | string
        is_buy: boolean
        location_id: number | string
      }
      const COLUMNS = 'transaction_id, date, type_id, quantity, unit_price, is_buy, location_id'

      // Personal and corp trades live in separate tables; a character's
      // trades on behalf of their corp (is_personal false) are already
      // captured in corp_wallet_transaction, so exclude them here to avoid
      // double-counting (cf. /market).
      let personalQuery = supabase
        .from('character_wallet_transaction')
        .select(`${COLUMNS}, character_id`)
        .eq('is_personal', true)
        .gte('date', since)
      let corpQuery = supabase.from('corp_wallet_transaction').select(`${COLUMNS}, corporation_id`).gte('date', since)
      if (side != null) {
        personalQuery = personalQuery.eq('is_buy', side === 'buy')
        corpQuery = corpQuery.eq('is_buy', side === 'buy')
      }
      if (typeIds) {
        personalQuery = personalQuery.in('type_id', typeIds)
        corpQuery = corpQuery.in('type_id', typeIds)
      }

      const [{ data: personalRows }, { data: corpRows }, owners] = await Promise.all([
        personalQuery.order('date', { ascending: false }).limit(maxRows),
        corpQuery.order('date', { ascending: false }).limit(maxRows),
        fetchOwnerContext(supabase),
      ])

      const rows = [
        ...((personalRows ?? []) as Array<TransactionRow & { character_id: string }>).map((r) => ({
          ...r,
          ownerId: r.character_id,
        })),
        ...((corpRows ?? []) as Array<TransactionRow & { corporation_id: number | string }>).map((r) => ({
          ...r,
          ownerId: String(r.corporation_id),
        })),
      ].sort((a, b) => (a.date < b.date ? 1 : -1))

      const typeNames = await getSdeTypeNames(rows.map((r) => Number(r.type_id)))
      const locationRefs = uniqBy(
        prop('id'),
        rows.map((r) => guessLocationRef(r.location_id)).filter((r): r is LocationRef => r != null)
      )
      const { nameFor } = await resolveLocations(locationRefs, supabase)

      const shown = rows.slice(0, maxRows)
      const totalFor = (isBuy: boolean) =>
        shown.filter((r) => r.is_buy === isBuy).reduce((sum, r) => sum + Number(r.unit_price) * Number(r.quantity), 0)

      return textResult({
        window_days: windowDays,
        rows_returned: shown.length,
        bought_isk: totalFor(true),
        sold_isk: totalFor(false),
        ...(rows.length > shown.length && {
          note: `More transactions matched than the ${maxRows}-row limit; totals cover only the rows returned. Narrow the window or filter by item for complete sums.`,
        }),
        transactions: shown.map((r) => {
          const ref = guessLocationRef(r.location_id)
          return {
            date: r.date,
            item: typeName(typeNames, r.type_id),
            side: r.is_buy ? 'buy' : 'sell',
            quantity: Number(r.quantity),
            unit_price: Number(r.unit_price),
            total: Number(r.unit_price) * Number(r.quantity),
            owner: owners.nameById.get(r.ownerId) ?? r.ownerId,
            location: ref ? nameFor(ref) : null,
          }
        }),
        data_refreshed: await dataFreshness(supabase, ['character-wallet-transactions', 'corp-wallet-transactions']),
      })
    }
  )

  server.registerTool(
    'blueprint_for_product',
    {
      title: 'Blueprint for a product',
      description:
        'Given something you want to build, return the blueprint that produces it (manufacturing or reaction) and its material bill — from static game data, independent of what you own. The bill is adjusted for the material-efficiency modifiers you pass: blueprint ME, an engineering-complex/refinery role bonus, a material-efficiency rig, and the system security that scales the rig.',
      inputSchema: {
        product: z.string().min(1).describe('The item you want to build, e.g. "Nightmare", "Nitrogen Fuel Block"'),
        ...MODIFIER_SHAPE,
      },
    },
    async ({ product, ...modifiers }, extra) => {
      const resolved = await resolveOneType(product)
      if (!resolved.ok) return textResult(resolved.message)

      const bp = await getBlueprintForProduct(resolved.typeID)
      if (!bp) {
        return textResult(
          `"${resolved.name}" has no manufacturing or reaction blueprint (nothing builds it from materials).${
            resolved.alsoMatched.length ? ` Other close name matches: ${resolved.alsoMatched.join(', ')}.` : ''
          }`
        )
      }

      const mods = await buildModifiers(modifiers, extra)
      if (!mods.ok) return textResult(mods.message)

      // A rig only discounts a build whose product its filter covers, so the
      // product's group/category decides which fitted rig (if any) applies.
      const productType = await getSdeType(bp.productTypeID)
      const productRef: ProductRef =
        productType != null ? { groupID: productType.groupID, categoryID: productType.categoryID ?? -1 } : null
      const { costParams, echo } = mods.resolve(bp.activityID, productRef)

      const names = await getSdeTypeNames([
        bp.blueprintTypeID,
        bp.productTypeID,
        ...bp.materials.map((mat) => mat.typeID),
      ])
      const runs = modifiers.runs ?? 1
      return textResult({
        product: names[bp.productTypeID] ?? resolved.name,
        ...(resolved.alsoMatched.length && { note: `Interpreted "${product}" as ${resolved.name}.` }),
        blueprint: names[bp.blueprintTypeID] ?? `Type #${bp.blueprintTypeID}`,
        activity: activityName(bp.activityID),
        produces_per_run: bp.productQuantity,
        produces_total: bp.productQuantity * runs,
        modifiers: echo,
        materials: modifiedMaterials(bp, costParams, names),
      })
    }
  )

  server.registerTool(
    'blueprints_using_material',
    {
      title: 'Blueprints using a material',
      description:
        'Given an input material, return every blueprint (manufacturing or reaction) that consumes it — from static game data. Each entry shows how much of this material that blueprint needs after the material-efficiency modifiers you pass (blueprint ME, structure role bonus, rig, and the security that scales the rig).',
      inputSchema: {
        material: z.string().min(1).describe('The input material, e.g. "Tritanium", "Fernite Carbide"'),
        ...MODIFIER_SHAPE,
      },
    },
    async ({ material, ...modifiers }, extra) => {
      const resolved = await resolveOneType(material)
      if (!resolved.ok) return textResult(resolved.message)

      const blueprints = await getBlueprintsForMaterial(resolved.typeID)
      if (blueprints.length === 0) {
        return textResult(
          `No blueprint consumes "${resolved.name}" as an input material.${
            resolved.alsoMatched.length ? ` Other close name matches: ${resolved.alsoMatched.join(', ')}.` : ''
          }`
        )
      }

      const mods = await buildModifiers(modifiers, extra)
      if (!mods.ok) return textResult(mods.message)

      const names = await getSdeTypeNames([
        resolved.typeID,
        ...blueprints.flatMap((bp) => [bp.blueprintTypeID, bp.productTypeID]),
      ])
      const shown = blueprints.slice(0, MAX_ROWS)
      // Bonuses vary per row twice over: by activity (a reaction gets the
      // refinery role bonus, manufacturing the engineering-complex one) and by
      // product (a fitted rig only covers certain groups). One bulk SDE lookup
      // feeds the per-row product refs.
      const productTypes = await getSdeTypes(shown.map((bp) => bp.productTypeID))
      const rows = shown.map((bp) => {
        const productType = productTypes[bp.productTypeID]
        const productRef: ProductRef =
          productType != null ? { groupID: productType.groupID, categoryID: productType.categoryID ?? -1 } : null
        const resolvedMods = mods.resolve(bp.activityID, productRef)
        // Adjust only this material's line; each blueprint's other inputs are
        // irrelevant to "how much of X does it take".
        const base = bp.materials.find((mat) => mat.typeID === resolved.typeID)?.quantity ?? 0
        const [quantityRequired] = cost({ base: [base], ...resolvedMods.costParams })
        // Per-row bonuses differ once a structure gates rigs by product, so the
        // shared inputs go in the top-level summary and each row reports the
        // rig actually applied to it.
        const appliedRig = (resolvedMods.echo.from_structure as { rig?: string | null } | undefined)?.rig
        return {
          product: names[bp.productTypeID] ?? `Type #${bp.productTypeID}`,
          blueprint: names[bp.blueprintTypeID] ?? `Type #${bp.blueprintTypeID}`,
          activity: activityName(bp.activityID),
          quantity_per_run: base,
          quantity_required: quantityRequired,
          ...(appliedRig !== undefined && { rig_applied: appliedRig }),
        }
      })

      return textResult({
        material: resolved.name,
        ...(resolved.alsoMatched.length && { note: `Interpreted "${material}" as ${resolved.name}.` }),
        total_blueprints: blueprints.length,
        modifiers: mods.summary,
        blueprints: rows,
        ...(capNote(blueprints.length, shown.length, 'blueprints') && {
          cap_note: capNote(blueprints.length, shown.length, 'blueprints'),
        }),
      })
    }
  )

  server.registerTool(
    'appraise_items',
    {
      title: 'Appraise items',
      description:
        'Estimate the ISK market value of a batch of items via the innomin.at appraisal service (Jita by default). Answers "what\'s 3 Rifters and 100k Tritanium worth" or follows up a search_assets result with prices. Item names are matched fuzzily against EVE types. Prices are live market data, not the user\'s own orders.',
      inputSchema: {
        items: z
          .array(
            z.object({
              item: z
                .string()
                .min(1)
                .describe('Item name, e.g. "Tritanium", "Rifter" (matched fuzzily against EVE types)'),
              quantity: z.number().int().min(1).optional().describe('How many (default 1)'),
            })
          )
          .min(1)
          .max(100)
          .describe('The items to appraise (1–100 distinct entries)'),
        market: z
          .enum(MARKETS)
          .optional()
          .describe(
            'Market hub to price against (default jita). Others: amarr, rens, dodi, hek, plus player markets ualx, cj6mt.'
          ),
      },
    },
    // No Supabase client and no bearer token: this tool reads nothing from the
    // DB. It still only runs for authenticated MCP callers (the whole server is
    // behind withMcpAuth), which is what gates the shared 200/hour budget.
    async ({ items, market }) => {
      // Canonicalize each fuzzy input against the SDE the way the blueprint
      // tools do. A match sends the canonical name (noting when it differs from
      // what was typed); a miss sends the raw name anyway so the API's own fuzzy
      // handling can return possible_matches — better than failing locally.
      const resolved = await Promise.all(
        items.map(async ({ item, quantity }) => {
          const match = await resolveOneType(item)
          const name = match.ok ? match.name : item.trim()
          return { input: item.trim(), name, quantity: quantity ?? 1 }
        })
      )

      const notes = resolved
        .filter((r) => r.name.toLowerCase() !== r.input.toLowerCase())
        .map((r) => `Interpreted "${r.input}" as ${r.name}.`)

      // Merge duplicate resolved names before sending — the API prices distinct
      // lines separately, which would double-count and inflate the batch.
      const merged = new Map<string, AppraisalItemInput>()
      resolved.forEach((r) => {
        const existing = merged.get(r.name)
        merged.set(r.name, { name: r.name, quantity: (existing?.quantity ?? 0) + r.quantity })
      })

      const result = await appraise([...merged.values()], (market ?? 'jita') as Market)
      if (!result.ok) {
        if (result.kind === 'unconfigured')
          return textResult("Appraisals aren't configured on this deployment (missing INNOMINATE_API_KEY).")
        if (result.kind === 'rate_limited')
          return textResult(
            `The appraisal service is rate limited.${
              result.retryAfterSeconds != null ? ` Try again in ${result.retryAfterSeconds}s.` : ''
            }`
          )
        return textResult(result.message)
      }

      const { appraisal } = result
      const priced = appraisal.items.filter((i) => i.error == null)
      const unpriced = appraisal.items.filter((i) => i.error != null)

      return textResult({
        market: appraisal.market,
        total_sell_value: appraisal.totalSellValue,
        total_buy_value: appraisal.totalBuyValue,
        price_split: appraisal.priceSplit,
        total_volume_m3: appraisal.totalVol,
        items: priced.map((i) => ({
          item: i.name,
          quantity: i.quantity,
          sell_price: i.sellPrice,
          buy_price: i.buyPrice,
          total_sell: i.totalSellPrice,
          total_buy: i.totalBuyPrice,
          volume_m3: i.totalItemVol,
        })),
        ...(unpriced.length && {
          unpriced: unpriced.map((i) => ({ item: i.name, possible_matches: i.possibleMatches })),
        }),
        ...(notes.length && { notes }),
        ...(appraisal.cached && { cached: true }),
        ...(appraisal.rateLimitRemaining != null && { rate_limit_remaining: appraisal.rateLimitRemaining }),
        source: 'innomin.at',
      })
    }
  )
}
