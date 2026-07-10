// The six MCP tools: read-only questions over the extracted EVE data ("where
// is my titan", "how many fuel blocks do I have in EKPB-3"). Tools accept
// fuzzy names (items, systems, owners) and return resolved names, mirroring
// the equivalent web pages' queries — the DB is the only source here; MCP
// never calls ESI (see the data-flow rule in CLAUDE.md). Auth: withMcpAuth
// (route.ts) verifies the caller's OAuth bearer token, and every query runs
// on a client carrying that token, so RLS scopes results to the caller.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import { prop, uniqBy } from 'ramda'
import { z } from 'zod'

import { ACTIVITY_NAMES } from '@/app/industry/jobFields'
import { resolveLocations, type LocationRef } from '@/app/resolveLocations'
import { fetchSystemNames } from '@/app/systemNames'
import { getSdeSystemNames, searchSdeSystems } from '@/sdeSystems'
import { getSdeTypeNames } from '@/sdeTypes'
import { createBearerClient } from '@/utils/supabase/bearer'

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

type SupabaseClient = ReturnType<typeof createBearerClient>

const clientFor = (extra: { authInfo?: AuthInfo }): SupabaseClient | null =>
  extra.authInfo?.token ? createBearerClient(extra.authInfo.token) : null

// Solar-system names resolve from the generated SDE data first (known space),
// falling back to the universe_name cache for anything the SDE build doesn't
// carry (e.g. wormhole systems).
const resolveSystemNames = async (supabase: SupabaseClient, systemIds: number[]): Promise<Record<number, string>> => {
  const fromSde = getSdeSystemNames(systemIds)
  const missing = systemIds.filter((id) => !(id in fromSde))
  const fromDb = await fetchSystemNames(missing, supabase)
  return { ...fromDb, ...fromSde }
}

const typeName = (names: Record<number, string>, typeId: number | string | null | undefined): string =>
  typeId == null ? '—' : (names[Number(typeId)] ?? `Type #${typeId}`)

const capNote = (total: number, shown: number, what: string): string | undefined =>
  total > shown ? `Showing the first ${shown} of ${total} ${what}; counts and totals cover everything.` : undefined

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

      const filter = resolveTypeFilter(item, { includeBlueprints: include_blueprints ?? false })
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
      const systemFilter = system?.trim() ? (searchSdeSystems(system, 1)[0]?.name ?? system.trim()).toLowerCase() : null

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
        'The user\'s characters with their current location, active implants, jump-clone locations (each with its implants), and when each character can next clone jump. Answers questions like "where is my nearest clone to Jita" or "which clone has my Genolution set".',
      inputSchema: {},
    },
    async (_args, extra) => {
      const supabase = clientFor(extra)
      if (!supabase) return textResult('Missing bearer token.')

      const [{ data: cloneRows }, { data: implantRows }, { data: locationRows }, { data: stateRows }, owners] =
        await Promise.all([
          supabase
            .from('character_clone')
            .select('character_id, jump_clone_id, is_home, location_id, location_type, name, implants, system_id'),
          supabase.from('character_implant').select('character_id, type_ids'),
          supabase.from('character_location').select('character_id, solar_system_id, station_id, structure_id'),
          supabase.from('character_clone_state').select('character_id, last_clone_jump_date'),
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

      const implantTypeIds = [
        ...clones.flatMap((c) => c.implants ?? []),
        ...((implantRows ?? []) as Array<{ type_ids: number[] }>).flatMap((r) => r.type_ids ?? []),
      ].map(Number)
      const implantNames = getSdeTypeNames(implantTypeIds)

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
        data_refreshed: await dataFreshness(supabase, ['character-clones', 'character-implants', 'character-location']),
      })
    }
  )

  server.registerTool(
    'list_blueprints',
    {
      title: 'List blueprints',
      description:
        'The user\'s character- and corporation-owned blueprints with ME/TE research levels, remaining runs (for copies), and location. Filter by name — searching by product works too ("naglfar" matches "Naglfar Blueprint") — or by owner.',
      inputSchema: {
        item: z.string().optional().describe('Blueprint (or product) name substring, e.g. "naglfar", "fuel block"'),
        owner: z
          .string()
          .optional()
          .describe('Only blueprints owned by this character or corporation (name substring)'),
      },
    },
    async ({ item, owner }, extra) => {
      const supabase = clientFor(extra)
      if (!supabase) return textResult('Missing bearer token.')

      const filter = resolveTypeFilter(item)
      if (!filter.ok) return textResult(filter.message)
      const typeIds = filter.matches?.map((m) => m.typeID) ?? null

      const owners = await fetchOwnerContext(supabase)
      const ownerFilter = resolveOwnerFilter(owner, owners)
      if (!ownerFilter.ok) return textResult(ownerFilter.message)

      type BlueprintRow = {
        item_id: number | string
        type_id: number | string
        location_id: number | string | null
        location_flag: string | null
        quantity: number | string | null
        material_efficiency: number | null
        time_efficiency: number | null
        runs: number | null
      }
      const COLUMNS =
        'item_id, type_id, location_id, location_flag, quantity, material_efficiency, time_efficiency, runs'

      const [characterRows, corpRows] = await Promise.all([
        fetchAllRows<BlueprintRow & { character_id: string }>((from, to) => {
          let q = supabase.from('character_blueprint').select(`${COLUMNS}, character_id`)
          if (typeIds) q = q.in('type_id', typeIds)
          return q.order('item_id').range(from, to)
        }),
        fetchAllRows<BlueprintRow & { corporation_id: number | string }>((from, to) => {
          let q = supabase.from('corp_blueprint').select(`${COLUMNS}, corporation_id`)
          if (typeIds) q = q.in('type_id', typeIds)
          return q.order('item_id').range(from, to)
        }),
      ])

      const rows = [
        ...characterRows.map((r) => ({ ...r, ownerId: r.character_id })),
        ...corpRows.map((r) => ({ ...r, ownerId: String(r.corporation_id) })),
      ].filter((r) => ownerFilter.ownerIds == null || ownerFilter.ownerIds.has(r.ownerId))

      const typeNames = getSdeTypeNames(rows.map((r) => Number(r.type_id)))
      const locationRefs = uniqBy(
        prop('id'),
        rows.map((r) => guessLocationRef(r.location_id)).filter((r): r is LocationRef => r != null)
      )
      const { nameFor, systemFor } = await resolveLocations(locationRefs, supabase)

      const sorted = rows
        .map((r) => {
          const ref = guessLocationRef(r.location_id)
          // ESI blueprint quantity: -2 is a copy, -1 a researched original,
          // positive a stack of unresearched originals.
          const isCopy = Number(r.quantity) === -2
          return {
            blueprint: typeName(typeNames, r.type_id),
            owner: owners.nameById.get(r.ownerId) ?? r.ownerId,
            kind: isCopy ? 'copy' : 'original',
            material_efficiency: r.material_efficiency,
            time_efficiency: r.time_efficiency,
            ...(isCopy && { runs: r.runs }),
            quantity: Number(r.quantity) > 0 ? Number(r.quantity) : 1,
            location: ref ? nameFor(ref) : null,
            ...(ref && systemFor(ref) != null && { system: systemFor(ref) }),
            hangar: r.location_flag,
          }
        })
        .sort((a, b) => a.blueprint.localeCompare(b.blueprint) || a.owner.localeCompare(b.owner))

      const shown = sorted.slice(0, MAX_ROWS)
      return textResult({
        total_blueprints: sorted.length,
        originals: sorted.filter((r) => r.kind === 'original').length,
        copies: sorted.filter((r) => r.kind === 'copy').length,
        blueprints: shown,
        ...(capNote(sorted.length, shown.length, 'blueprints') && {
          note: capNote(sorted.length, shown.length, 'blueprints'),
        }),
        data_refreshed: await dataFreshness(supabase, ['character-blueprints', 'corp-blueprints']),
      })
    }
  )

  server.registerTool(
    'list_industry_jobs',
    {
      title: 'List industry jobs',
      description:
        'Manufacturing, research, invention, copying, and reaction jobs across the user\'s characters and corporations. Defaults to active jobs; pass a status ("ready", "delivered", …) or "all" for history. Answers "what\'s building right now" or "when does my research finish".',
      inputSchema: {
        status: z
          .enum(['active', 'ready', 'paused', 'delivered', 'cancelled', 'reverted', 'all'])
          .optional()
          .describe('Job status to show (default "active")'),
        owner: z.string().optional().describe('Only jobs for this character or corporation (name substring)'),
      },
    },
    async ({ status, owner }, extra) => {
      const supabase = clientFor(extra)
      if (!supabase) return textResult('Missing bearer token.')

      const owners = await fetchOwnerContext(supabase)
      const ownerFilter = resolveOwnerFilter(owner, owners)
      if (!ownerFilter.ok) return textResult(ownerFilter.message)

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
      const [characterJobs, corpJobs] = await Promise.all([
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

      // A corp job installed by one of our own characters shows up in both
      // extracts under the same job_id; the corp row wins (cf. /industry).
      const corpJobIds = new Set(corpJobs.map((j) => String(j.job_id)))
      const rows = [
        ...characterJobs
          .filter((j) => !corpJobIds.has(String(j.job_id)))
          .map((j) => ({ ...j, ownerId: j.character_id })),
        ...corpJobs.map((j) => ({ ...j, ownerId: String(j.corporation_id) })),
      ]
        .filter((j) => ownerFilter.ownerIds == null || ownerFilter.ownerIds.has(j.ownerId))
        .sort((a, b) => new Date(a.end_date).getTime() - new Date(b.end_date).getTime())

      const typeNames = getSdeTypeNames(
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
            owner: owners.nameById.get(j.ownerId) ?? j.ownerId,
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
        'The user\'s open market orders (buys and sells) across all characters, with price, remaining volume, location, and expiry. Answers "what am I selling" or "do I still have that buy order up".',
      inputSchema: {
        item: z.string().optional().describe('Only orders for items matching this name substring'),
      },
    },
    async ({ item }, extra) => {
      const supabase = clientFor(extra)
      if (!supabase) return textResult('Missing bearer token.')

      const filter = resolveTypeFilter(item)
      if (!filter.ok) return textResult(filter.message)
      const typeIds = filter.matches?.map((m) => m.typeID) ?? null

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
      const [orders, owners] = await Promise.all([
        fetchAllRows<OrderRow>((from, to) => {
          const q = supabase
            .from('character_order')
            .select(
              'order_id, character_id, type_id, location_id, is_buy, is_corporation, price, volume_total, volume_remain, min_volume, escrow, duration, issued'
            )
            .order('issued', { ascending: false })
            .range(from, to)
          return typeIds ? q.in('type_id', typeIds) : q
        }),
        fetchOwnerContext(supabase),
      ])

      const typeNames = getSdeTypeNames(orders.map((o) => Number(o.type_id)))
      const locationRefs = uniqBy(
        prop('id'),
        orders.map((o) => guessLocationRef(o.location_id)).filter((r): r is LocationRef => r != null)
      )
      const { nameFor } = await resolveLocations(locationRefs, supabase)

      const sells = orders.filter((o) => !o.is_buy)
      const buys = orders.filter((o) => o.is_buy)
      const shown = orders.slice(0, MAX_ROWS)
      return textResult({
        total_orders: orders.length,
        sell_orders: sells.length,
        sell_value_remaining: sells.reduce((sum, o) => sum + Number(o.price) * Number(o.volume_remain), 0),
        buy_orders: buys.length,
        buy_escrow: buys.reduce((sum, o) => sum + Number(o.escrow ?? 0), 0),
        orders: shown.map((o) => {
          const ref = guessLocationRef(o.location_id)
          return {
            item: typeName(typeNames, o.type_id),
            side: o.is_buy ? 'buy' : 'sell',
            price: Number(o.price),
            volume_remain: Number(o.volume_remain),
            volume_total: Number(o.volume_total),
            owner: owners.nameById.get(o.character_id) ?? o.character_id,
            ...(o.is_corporation && { corporation_order: true }),
            location: ref ? nameFor(ref) : null,
            issued: o.issued,
            expires: new Date(new Date(o.issued).getTime() + o.duration * 24 * 60 * 60 * 1000).toISOString(),
            ...(o.min_volume != null && Number(o.min_volume) > 1 && { min_volume: Number(o.min_volume) }),
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

      const filter = resolveTypeFilter(item)
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

      const typeNames = getSdeTypeNames(rows.map((r) => Number(r.type_id)))
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
}
