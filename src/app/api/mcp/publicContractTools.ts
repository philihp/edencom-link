// search_public_contracts: every public contract New Eden has listed since the
// public-contracts extract started, open or closed (docs/public-contracts.md).
// The tables are members-read intel, not the caller's own data, so this runs
// on the caller's bearer client like every other tool but needs no owner
// scoping. The query itself is public_contract_search(); this module resolves
// fuzzy names to ids and names the rows coming back (publicContractQuery.ts).
import type { AuthInfo, McpServer } from '@modelcontextprotocol/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'

import { searchSdeRegions, getSdeRegionNames } from '@/sdeRegions'
import { getSdeSystemNames, searchSdeSystems } from '@/sdeSystems'
import { getSdeTypeNames } from '@/sdeTypes'
import { escapeLike } from '@/utils/escapeLike'
import { createBearerClient } from '@/utils/supabase/bearer'

import { capNote, dataFreshness, resolveTypeFilter, textResult, type ToolResult } from './lib'
import {
  CONTRACT_TYPES,
  DEFAULT_ITEMS_PER_CONTRACT,
  DEFAULT_LIMIT,
  formatContract,
  idsToName,
  issuedSince,
  MAX_ITEMS_PER_CONTRACT,
  MAX_LIMIT,
  narrowingFilterMissing,
  parseIssuer,
  searchParams,
  SORTS,
  STATUSES,
  type SearchPayload,
} from './publicContractQuery'

const clientFor = (ctx: { http?: { authInfo?: AuthInfo } }): SupabaseClient | null =>
  ctx.http?.authInfo?.token ? createBearerClient(ctx.http.authInfo.token) : null

type NameRow = { id: number | string; name: string | null }

// Characters and corporations by exact name (case-insensitive), from the three
// places a name can be on file: the universe_name cache, and the
// world-readable directories of registered characters and their corporations.
const issuerIdsByName = async (supabase: SupabaseClient, name: string): Promise<number[]> => {
  const pattern = escapeLike(name)
  const [cached, characters, corporations] = await Promise.all([
    supabase
      .from('universe_name')
      .select('id, name')
      .ilike('name', pattern)
      .in('category', ['character', 'corporation']),
    supabase.from('character_directory').select('id:character_id, name').ilike('name', pattern),
    supabase.from('corporation').select('id:corporation_id, name').ilike('name', pattern),
  ])
  const rows = [cached, characters, corporations].flatMap((r) => (r.data ?? []) as NameRow[])
  return [...new Set(rows.map((r) => Number(r.id)))]
}

const issuerNames = async (supabase: SupabaseClient, ids: number[]): Promise<Map<number, string>> => {
  if (ids.length === 0) return new Map()
  const [cached, characters, corporations] = await Promise.all([
    supabase.from('universe_name').select('id, name').in('id', ids),
    supabase.from('character_directory').select('id:character_id, name').in('character_id', ids),
    supabase.from('corporation').select('id:corporation_id, name').in('corporation_id', ids),
  ])
  return new Map(
    [cached, characters, corporations]
      .flatMap((r) => (r.data ?? []) as NameRow[])
      .flatMap((r): Array<[number, string]> => (r.name ? [[Number(r.id), r.name]] : []))
  )
}

export const registerPublicContractTools = (server: McpServer): void => {
  server.registerTool(
    'search_public_contracts',
    {
      title: 'Search public contracts',
      description:
        'Search every public contract New Eden has listed since the extract started — open and closed, every region, anyone\'s, not just the user\'s. Answers "who is selling a Nightmare on contract and for how much", "what couriers are leaving Jita", "what has this corporation put up", "which Raven contracts sold this week" (status closed: a contract that left the listing before its expiry was accepted or withdrawn — ESI cannot tell which). Name at least one of item, region, system or issuer. Item matches contracts OFFERING it (an item a contract asks for does not match, but is listed with requested: true). Newest first unless sorted by price. Each contract lists its first item lines; totals cover every match.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({
        item: z
          .string()
          .optional()
          .describe('Only contracts offering an item matching this name, e.g. "Nightmare", "Raven Blueprint"'),
        region: z.string().optional().describe('Only contracts in this region (fuzzy name, e.g. "The Forge")'),
        system: z
          .string()
          .optional()
          .describe(
            'Only contracts starting in this solar system (fuzzy name). Covers NPC stations and player structures we know the system of.'
          ),
        issuer: z
          .string()
          .optional()
          .describe('Only contracts issued by this character or corporation — an exact name, or an EVE id'),
        contract_type: z
          .array(z.enum(CONTRACT_TYPES))
          .min(1)
          .optional()
          .describe('Only these contract types (default all)'),
        status: z
          .enum(STATUSES)
          .optional()
          .describe(
            '"outstanding" (default) = still listed; "closed" = expired, or gone (accepted or withdrawn); "any" = both'
          ),
        min_price: z
          .number()
          .nonnegative()
          .optional()
          .describe("Minimum price in ISK (an auction's starting bid). Excludes couriers."),
        max_price: z.number().nonnegative().optional().describe('Maximum price in ISK. Excludes couriers.'),
        issued_within_days: z
          .number()
          .int()
          .min(1)
          .max(3650)
          .optional()
          .describe('Only contracts issued in the last N days'),
        sort: z.enum(SORTS).optional().describe('"newest" (default), "price_asc" or "price_desc"'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_LIMIT)
          .optional()
          .describe(`Maximum contracts to return (default ${DEFAULT_LIMIT})`),
        items_per_contract: z
          .number()
          .int()
          .min(0)
          .max(MAX_ITEMS_PER_CONTRACT)
          .optional()
          .describe(`Item lines listed per contract (default ${DEFAULT_ITEMS_PER_CONTRACT})`),
      }),
    },
    async (args, ctx): Promise<ToolResult> => {
      const supabase = clientFor(ctx)
      if (!supabase) return textResult('Missing bearer token.')
      const notes: string[] = []

      const typeFilter = await resolveTypeFilter(args.item)
      if (!typeFilter.ok) return textResult(typeFilter.message)

      const regionMatch = args.region?.trim() ? (await searchSdeRegions(args.region, 1))[0] : undefined
      if (args.region?.trim() && !regionMatch) return textResult(`No region matched "${args.region}".`)
      if (regionMatch && regionMatch.name.toLowerCase() !== args.region!.trim().toLowerCase()) {
        notes.push(`Interpreted region "${args.region}" as ${regionMatch.name}.`)
      }

      const systemMatch = args.system?.trim() ? (await searchSdeSystems(args.system, 1))[0] : undefined
      if (args.system?.trim() && !systemMatch) return textResult(`No solar system matched "${args.system}".`)
      if (systemMatch && systemMatch.name.toLowerCase() !== args.system!.trim().toLowerCase()) {
        notes.push(`Interpreted system "${args.system}" as ${systemMatch.name}.`)
      }

      const issuer = parseIssuer(args.issuer)
      const issuerIds =
        issuer == null ? null : issuer.kind === 'id' ? [issuer.id] : await issuerIdsByName(supabase, issuer.name)
      if (issuerIds != null && issuerIds.length === 0) {
        return textResult(
          `No character or corporation named "${args.issuer}" is on file. Pass its EVE id instead, or check the spelling (names match exactly, ignoring case).`
        )
      }

      const resolved = {
        typeIds: typeFilter.matches?.map((m) => m.typeID) ?? null,
        regionIds: regionMatch ? [regionMatch.regionID] : null,
        systemIds: systemMatch ? [systemMatch.systemID] : null,
        issuerIds,
        contractTypes: args.contract_type ?? null,
        status: args.status ?? 'outstanding',
        minPrice: args.min_price ?? null,
        maxPrice: args.max_price ?? null,
        issuedSince: issuedSince(args.issued_within_days, new Date()),
        sort: args.sort ?? 'newest',
        limit: args.limit ?? DEFAULT_LIMIT,
        itemsPerContract: args.items_per_contract ?? DEFAULT_ITEMS_PER_CONTRACT,
      }
      if (narrowingFilterMissing(resolved)) {
        return textResult(
          'Name at least one of item, region, system or issuer — public contracts are too many to list unfiltered.'
        )
      }

      const { data, error } = await supabase.rpc('public_contract_search', searchParams(resolved))
      if (error) return textResult(`Public contract search failed: ${error.message}`)
      const payload = data as SearchPayload

      const ids = idsToName(payload.contracts)
      const [types, systems, regions, issuers, freshness] = await Promise.all([
        getSdeTypeNames(ids.typeIds),
        getSdeSystemNames(ids.systemIds),
        getSdeRegionNames(ids.regionIds),
        issuerNames(supabase, ids.issuerIds),
        dataFreshness(supabase, ['public-contracts']),
      ])
      const names = { types, systems, regions, issuers }

      const cap = capNote(payload.total, payload.contracts.length, 'contracts')
      return textResult({
        ...(typeFilter.matches && {
          item_types: typeFilter.matches.slice(0, 10).map((m) => m.name),
          ...(typeFilter.matches.length > 10 && { item_types_matched: typeFilter.matches.length }),
        }),
        ...(regionMatch && { region: regionMatch.name }),
        ...(systemMatch && { system: systemMatch.name }),
        status: resolved.status,
        total: payload.total,
        contracts: payload.contracts.map((r) => formatContract(r, names)),
        ...((notes.length > 0 || cap) && { note: [...notes, ...(cap ? [cap] : [])].join(' ') }),
        data_refreshed: freshness,
      })
    }
  )
}
