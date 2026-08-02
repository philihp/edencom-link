// MCP tools over what the user *has* and what state it's in: hangars browsed by
// location rather than by item name, monitored Upwell structures (and their fuel
// clocks), wallet balances, deployed Mercenary Dens, and the ship fittings their
// characters have saved in the game. Same rules as tools.ts —
// every query runs on the caller's bearer-token client so RLS scopes results,
// the DB is the only source, and nothing here calls ESI.
//
// One tool leaves the deployment: appraise_assets prices what it finds against
// innomin.at — the same narrow third-party exception appraise_items takes (see
// docs/appraisals/README.md) — which is why it alone here carries
// openWorldHint: true. It sends type names and quantities and nothing else; no
// owner, character, corporation or location ever reaches the provider.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import { ascend, descend, groupBy, sortWith } from 'ramda'
import { z } from 'zod'

import { MAX_LINES } from '@/app/api/appraisal/assetLines'
import { collectAssetLines } from '@/app/api/appraisal/collectAssetLines'
import { fittingRoute, flagSortKey, groupForFlag, type FittingItem, type FittingRow } from '@/app/fitting/fit'
import { fetchFittingOwners } from '@/app/fitting/resolveCharacter'
import { resolveLocations, type LocationRef } from '@/app/resolveLocations'
import { appraise, MARKETS, type Market } from '@/innominate'
import { getSdePlanets } from '@/sdePlanets'
import { searchSdeSystems } from '@/sdeSystems'
import { getSdeTypeNames } from '@/sdeTypes'
import { createBearerClient } from '@/utils/supabase/bearer'

import {
  dataFreshness,
  fetchAllRows,
  fetchOwnerContext,
  resolveOwnerFilter,
  resolveTypeFilter,
  textResult,
  type OwnerContext,
} from './lib'

const MAX_ROWS = 200

// How many lines an appraisal itemizes when the caller didn't ask for all of
// them — enough to say what the value is made of, short enough that pricing a
// whole station stays a summary.
const TOP_ITEMS = 10

type SupabaseClient = ReturnType<typeof createBearerClient>

const clientFor = (extra: { authInfo?: AuthInfo }): SupabaseClient | null =>
  extra.authInfo?.token ? createBearerClient(extra.authInfo.token) : null

const capNote = (total: number, shown: number, what: string): string | undefined =>
  total > shown ? `Showing the first ${shown} of ${total} ${what}; counts and totals cover everything.` : undefined

// ── assets by location ────────────────────────────────────────────────────

// One root location the caller holds assets in, with per-owner stack counts —
// the same rollup /asset builds from the two *_asset_location_summary() RPCs
// (which do the location-chain walk in Postgres so a big hangar doesn't page
// into Node).
type LocationBucket = { root: LocationRef; counts: Map<string, number> }

const fetchLocationBuckets = async (supabase: SupabaseClient): Promise<LocationBucket[]> => {
  type SummaryRow = { location_id: number | string; location_type: string | null; stacks: number | string }
  const [{ data: characterSummary }, { data: corpSummary }] = await Promise.all([
    supabase.rpc('character_asset_location_summary'),
    supabase.rpc('corp_asset_location_summary'),
  ])
  const rows = [
    ...((characterSummary ?? []) as Array<SummaryRow & { registration_id: string }>).map((r) => ({
      ...r,
      ownerId: r.registration_id,
    })),
    ...((corpSummary ?? []) as Array<SummaryRow & { corporation_id: number | string }>).map((r) => ({
      ...r,
      ownerId: String(r.corporation_id),
    })),
  ]

  const byLocation = new Map<string, LocationBucket>()
  rows.forEach((row) => {
    const id = String(row.location_id)
    const entry = byLocation.get(id) ?? { root: { id, type: row.location_type }, counts: new Map<string, number>() }
    entry.counts.set(row.ownerId, (entry.counts.get(row.ownerId) ?? 0) + Number(row.stacks))
    byLocation.set(id, entry)
  })
  return [...byLocation.values()]
}

// The items sitting directly in one location (not nested deeper), from both the
// character and corp hangars, each with the size of its own subtree.
const fetchLocationContents = async (supabase: SupabaseClient, locationId: string, owners: OwnerContext) => {
  type AssetRow = {
    item_id: number | string
    type_id: number | string
    location_flag: string | null
    quantity: number | string | null
    is_singleton: boolean | null
  }
  const COLUMNS = 'item_id, type_id, location_flag, quantity, is_singleton'
  const [{ data: characterRows }, { data: corpRows }, { data: characterContents }, { data: corpContents }] =
    await Promise.all([
      supabase.from('character_asset').select(`${COLUMNS}, registration_id, name`).eq('location_id', locationId),
      supabase.from('corp_asset').select(`${COLUMNS}, corporation_id`).eq('location_id', locationId),
      supabase.rpc('character_asset_location_contents', { parent: locationId }),
      supabase.rpc('corp_asset_location_contents', { parent: locationId }),
    ])

  // An item lives in exactly one of the two tables, so the counts can't collide.
  const contentsByItem = new Map(
    [
      ...((characterContents ?? []) as Array<{ item_id: number | string; contents: number | string }>),
      ...((corpContents ?? []) as Array<{ item_id: number | string; contents: number | string }>),
    ].map((r) => [String(r.item_id), Number(r.contents)])
  )

  return [
    ...((characterRows ?? []) as Array<AssetRow & { registration_id: string; name: string | null }>).map((r) => ({
      ...r,
      ownerId: r.registration_id,
    })),
    ...((corpRows ?? []) as Array<AssetRow & { corporation_id: number | string }>).map((r) => ({
      ...r,
      name: null as string | null,
      ownerId: String(r.corporation_id),
    })),
  ].map((r) => ({
    itemId: String(r.item_id),
    typeId: Number(r.type_id),
    customName: r.name,
    // Singletons (assembled ships, containers, …) report a null/1 quantity.
    quantity: r.is_singleton ? 1 : Number(r.quantity ?? 1),
    flag: r.location_flag,
    ownerId: r.ownerId,
    owner: owners.nameById.get(r.ownerId) ?? r.ownerId,
    contents: contentsByItem.get(String(r.item_id)) ?? 0,
  }))
}

// Every root place the caller holds assets in, named and placed. Shared by
// browse_assets and appraise_assets, which both take a location the same way.
type DescribedLocation = { id: string; name: string | null; system: string | null; counts: Map<string, number> }

const describeLocations = async (supabase: SupabaseClient): Promise<DescribedLocation[]> => {
  const buckets = await fetchLocationBuckets(supabase)
  const { nameFor, systemFor } = await resolveLocations(
    buckets.map((b) => b.root),
    supabase
  )
  return buckets.map((b) => {
    const floating = b.root.type === 'solar_system'
    return {
      id: b.root.id,
      name: nameFor(b.root),
      system: systemFor(b.root) ?? (floating ? nameFor(b.root) : null),
      counts: b.counts,
    }
  })
}

// Resolve what the caller called a location to one id. A raw id is taken as-is
// (that's the only way to reach a container or ship, which the location summary
// never lists — it only reports root places); a name matches against the
// resolved places, exact match winning over several substring hits. Failure
// carries the candidates so each tool can word its own message.
type LocationMatch =
  { matched: true; id: string; name: string | null } | { matched: false; candidates: DescribedLocation[] }

const matchLocation = (query: string, described: DescribedLocation[]): LocationMatch => {
  if (/^\d+$/.test(query)) {
    return { matched: true, id: query, name: described.find((d) => d.id === query)?.name ?? `Location #${query}` }
  }
  const needle = query.toLowerCase()
  const matches = described.filter((d) => (d.name ?? '').toLowerCase().includes(needle))
  if (matches.length === 0) return { matched: false, candidates: [] }
  if (matches.length === 1) return { matched: true, id: matches[0].id, name: matches[0].name }
  const exact = matches.find((d) => (d.name ?? '').toLowerCase() === needle)
  return exact ? { matched: true, id: exact.id, name: exact.name } : { matched: false, candidates: matches }
}

// ── tools ─────────────────────────────────────────────────────────────────

export const registerEstateTools = (server: McpServer): void => {
  server.registerTool(
    'browse_assets',
    {
      title: 'Browse assets by location',
      description:
        'Walk the user\'s hangars by place instead of by item name: with no arguments, every station, structure, and system where they hold assets, with stack counts; with a location, the items sitting directly in it. Answers "what do I have in Jita" or "what\'s in that container". Use search_assets when you know the item name and want to find where it is.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        location: z
          .string()
          .optional()
          .describe(
            'The place to list the contents of — a station/structure/system name substring, or a raw id (which also works for drilling into one of your own containers or ships). Omit to list every location instead.'
          ),
        system: z
          .string()
          .optional()
          .describe('When listing locations, only those in this solar system, e.g. "EKPB-3"'),
        owner: z.string().optional().describe('Only stacks owned by this character or corporation (name substring)'),
      },
    },
    async ({ location, system, owner }, extra) => {
      const supabase = clientFor(extra)
      if (!supabase) return textResult('Missing bearer token.')

      const owners = await fetchOwnerContext(supabase)
      const ownerFilter = resolveOwnerFilter(owner, owners)
      if (!ownerFilter.ok) return textResult(ownerFilter.message)

      const described = await describeLocations(supabase)

      // Drill into one location.
      const query = location?.trim()
      if (query) {
        const match = matchLocation(query, described)
        if (!match.matched) {
          if (match.candidates.length === 0) {
            return textResult(
              `No location you hold assets in matched "${query}". Call browse_assets with no arguments to see the list, or pass a raw id to drill into a container.`
            )
          }
          return textResult({
            ambiguous: query,
            matched: match.candidates.map((d) => ({ id: d.id, name: d.name, system: d.system })),
            note: 'Several locations matched; call again with a more specific name or one of these ids.',
          })
        }
        const { id: targetId, name: targetName } = match

        const items = (await fetchLocationContents(supabase, targetId, owners)).filter(
          (i) => ownerFilter.ownerIds == null || ownerFilter.ownerIds.has(i.ownerId)
        )
        const typeNames = await getSdeTypeNames(items.map((i) => i.typeId))
        const sorted = items.sort(
          (a, b) => b.contents - a.contents || (typeNames[a.typeId] ?? '').localeCompare(typeNames[b.typeId] ?? '')
        )
        const shown = sorted.slice(0, MAX_ROWS)
        return textResult({
          location: targetName,
          location_id: targetId,
          total_stacks: sorted.length,
          items: shown.map((i) => ({
            item: typeNames[i.typeId] ?? `Type #${i.typeId}`,
            quantity: i.quantity,
            owner: i.owner,
            hangar: i.flag,
            ...(i.customName != null && { custom_name: i.customName }),
            // A stack holding items is a container or ship; its id drills in.
            ...(i.contents > 0 && { contains_items: i.contents, drill_in_with_id: i.itemId }),
          })),
          ...(capNote(sorted.length, shown.length, 'stacks') && {
            note: capNote(sorted.length, shown.length, 'stacks'),
          }),
          data_refreshed: await dataFreshness(supabase, ['character-assets', 'corp-assets']),
        })
      }

      // Otherwise: the whole list of places, most stacks first.
      const systemMatch = system?.trim() ? ((await searchSdeSystems(system, 1))[0]?.name ?? system.trim()) : null
      const systemFilter = systemMatch != null ? systemMatch.toLowerCase() : null

      const locations = described
        .map((d) => {
          const counts = [...d.counts].filter(([id]) => ownerFilter.ownerIds == null || ownerFilter.ownerIds.has(id))
          return {
            id: d.id,
            name: d.name,
            system: d.system,
            stacks: counts.reduce((sum, [, n]) => sum + n, 0),
            by_owner: Object.fromEntries(counts.map(([id, n]) => [owners.nameById.get(id) ?? id, n])),
          }
        })
        .filter((d) => d.stacks > 0)
        .filter((d) => systemFilter == null || (d.system ?? '').toLowerCase() === systemFilter)
        .sort((a, b) => b.stacks - a.stacks || (a.name ?? '').localeCompare(b.name ?? ''))

      const shown = locations.slice(0, MAX_ROWS)
      return textResult({
        ...(systemFilter != null && { system_filter: systemMatch }),
        total_locations: locations.length,
        total_stacks: locations.reduce((sum, l) => sum + l.stacks, 0),
        locations: shown,
        note: 'Pass a location name (or one of these ids) to list what is in it.',
        ...(capNote(locations.length, shown.length, 'locations') && {
          cap_note: capNote(locations.length, shown.length, 'locations'),
        }),
        data_refreshed: await dataFreshness(supabase, ['character-assets', 'corp-assets']),
      })
    }
  )

  server.registerTool(
    'appraise_assets',
    {
      title: 'Appraise a location or container',
      description:
        'Price everything the user actually holds in one place — a station, structure or system, or one ship/container drilled into by id — as a single ISK valuation via innomin.at (Jita by default). Answers "what is my Jita hangar worth" or "how much is this hauler and its cargo worth". Contents are counted recursively, so a container is priced with everything nested inside it. Use browse_assets first to find the place or the id; use appraise_items when you already know the item names and quantities and are not pricing a hangar.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        location: z
          .string()
          .min(1)
          .describe(
            'What to price — a station/structure/system name substring, or a raw id (the only way to reach one of your own ships or containers; browse_assets reports it as drill_in_with_id)'
          ),
        market: z
          .enum(MARKETS)
          .optional()
          .describe(
            'Market hub to price against (default jita). Others: amarr, rens, dodi, hek, plus player markets ualx, cj6mt.'
          ),
        include_items: z
          .boolean()
          .optional()
          .describe('Itemize every priced type rather than just the most valuable few (default false)'),
      },
    },
    async ({ location, market, include_items }, extra) => {
      const supabase = clientFor(extra)
      if (!supabase) return textResult('Missing bearer token.')

      const match = matchLocation(location.trim(), await describeLocations(supabase))
      if (!match.matched) {
        if (match.candidates.length === 0) {
          return textResult(
            `No location you hold assets in matched "${location}". Call browse_assets with no arguments to see the list, or pass a raw id to appraise a ship or container.`
          )
        }
        return textResult({
          ambiguous: location,
          matched: match.candidates.map((d) => ({ id: d.id, name: d.name, system: d.system })),
          note: 'Several locations matched; call again with a more specific name or one of these ids.',
        })
      }

      // The same walk the asset viewer's appraise button does, so page and tool
      // can't disagree about what is inside a container or what goes unpriced.
      const { lines, skippedBlueprints, unnamed } = await collectAssetLines(supabase, match.id)
      if (lines.length === 0) {
        return textResult(
          `Nothing at ${match.name ?? match.id} can be appraised.${
            skippedBlueprints > 0
              ? ` Its ${skippedBlueprints} blueprint types are never priced — an asset row can't tell an original from a worthless copy.`
              : ''
          }`
        )
      }
      if (lines.length > MAX_LINES) {
        return textResult(
          `${match.name ?? match.id} holds ${lines.length} distinct item types — too many to appraise in one request (limit ${MAX_LINES}). Appraise a container or a specific ship inside it instead.`
        )
      }

      // save is never set here: an MCP call is not a user asking the provider to
      // store a record. Only the viewer's explicit "open this appraisal" arrow
      // does that (docs/appraisals/README.md).
      const result = await appraise(lines, (market ?? 'jita') as Market)
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
      const priced = sortWith(
        [descend((i: (typeof appraisal.items)[number]) => i.totalSellPrice ?? 0)],
        appraisal.items.filter((i) => i.error == null)
      )
      // A hangar's full itemization is mostly noise next to the total, so only
      // the biggest lines come back unless asked. The totals always cover
      // everything either way — they come from the batch, not from these rows.
      const shown = priced.slice(0, include_items ? MAX_ROWS : TOP_ITEMS)
      const unpriced = [...unnamed, ...appraisal.items.filter((i) => i.error != null).map((i) => i.name)]

      return textResult({
        location: match.name,
        location_id: match.id,
        market: appraisal.market,
        total_sell_value: appraisal.totalSellValue,
        total_buy_value: appraisal.totalBuyValue,
        price_split: appraisal.priceSplit,
        total_volume_m3: appraisal.totalVol,
        line_count: lines.length,
        items: shown.map((i) => ({
          item: i.name,
          quantity: i.quantity,
          sell_price: i.sellPrice,
          buy_price: i.buyPrice,
          total_sell: i.totalSellPrice,
          total_buy: i.totalBuyPrice,
          volume_m3: i.totalItemVol,
        })),
        // Not capNote's wording: these are the most valuable lines, not the
        // first ones, and saying "the first N" of a value-sorted list would
        // misdescribe what was left out.
        ...(priced.length > shown.length && {
          cap_note: `Showing the ${shown.length} most valuable of ${priced.length} priced types; the totals cover all of them.${
            include_items ? '' : ' Pass include_items to itemize the rest.'
          }`,
        }),
        // Blueprints are skipped deliberately: an asset row can't tell an
        // original from a worthless copy, so pricing them would be wrong more
        // often than right.
        ...(skippedBlueprints > 0 && { skipped_blueprints: skippedBlueprints }),
        ...(unpriced.length > 0 && { unpriced }),
        ...(appraisal.cached && { cached: true }),
        ...(appraisal.rateLimitRemaining != null && { rate_limit_remaining: appraisal.rateLimitRemaining }),
        data_refreshed: await dataFreshness(supabase, ['character-assets', 'corp-assets']),
      })
    }
  )

  server.registerTool(
    'wallet_summary',
    {
      title: 'Wallet summary',
      description:
        'Current ISK balances for the user\'s characters and their corporations\' wallet divisions, plus a breakdown of corp wallet activity by entry type over a recent window. Answers "how much ISK do I have" or "where did the corp wallet go this month". Use search_transactions for individual market trades.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        days: z
          .number()
          .int()
          .min(1)
          .max(365)
          .optional()
          .describe('Window for the corporation wallet-journal breakdown, in days (default 30)'),
      },
    },
    async ({ days }, extra) => {
      const supabase = clientFor(extra)
      if (!supabase) return textResult('Missing bearer token.')

      const owners = await fetchOwnerContext(supabase)
      const windowDays = days ?? 30
      const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString()

      // character_wallet is append-only (one row per extract run), so the latest
      // balance is a per-character limit(1) rather than a scan of all history.
      const balances = await Promise.all(
        owners.registrationIds.map(async (characterId) => {
          const { data } = await supabase
            .from('character_wallet')
            .select('balance, recorded_at')
            .eq('registration_id', characterId)
            .order('recorded_at', { ascending: false })
            .limit(1)
            .maybeSingle()
          return {
            character: owners.nameById.get(characterId) ?? characterId,
            balance: data?.balance != null ? Number(data.balance) : null,
            recorded_at: data?.recorded_at ?? null,
          }
        })
      )

      // Corp division balances: each journal entry carries the running balance
      // after it, so the newest entry per (corporation, division) is current.
      const { data: recentJournal } = await supabase
        .from('corp_wallet_journal')
        .select('corporation_id, division, balance, date')
        .order('date', { ascending: false })
        .limit(500)
      const divisionBalances = new Map<
        string,
        { corporation: string; division: number; balance: number; as_of: string }
      >()
      ;(
        (recentJournal ?? []) as Array<{
          corporation_id: number | string
          division: number
          balance: number | string | null
          date: string
        }>
      ).forEach((r) => {
        const key = `${r.corporation_id}:${r.division}`
        if (divisionBalances.has(key) || r.balance == null) return
        divisionBalances.set(key, {
          corporation: owners.nameById.get(String(r.corporation_id)) ?? String(r.corporation_id),
          division: r.division,
          balance: Number(r.balance),
          as_of: r.date,
        })
      })

      // Where the corp wallet moved over the window, by entry type.
      const journal = await fetchAllRows<{ ref_type: string; amount: number | string | null }>((from, to) =>
        supabase
          .from('corp_wallet_journal')
          .select('ref_type, amount')
          .gte('date', since)
          .order('date', { ascending: false })
          .range(from, to)
      )
      const byRefType = new Map<string, { entries: number; total: number }>()
      journal.forEach((r) => {
        const entry = byRefType.get(r.ref_type) ?? { entries: 0, total: 0 }
        entry.entries += 1
        entry.total += Number(r.amount ?? 0)
        byRefType.set(r.ref_type, entry)
      })
      const movements = [...byRefType]
        .map(([ref_type, v]) => ({ ref_type, ...v }))
        .sort((a, b) => Math.abs(b.total) - Math.abs(a.total))

      const characterTotal = balances.reduce((sum, b) => sum + (b.balance ?? 0), 0)
      const corpTotal = [...divisionBalances.values()].reduce((sum, d) => sum + d.balance, 0)

      return textResult({
        characters: balances.sort((a, b) => (b.balance ?? 0) - (a.balance ?? 0)),
        total_character_isk: characterTotal,
        corporation_divisions: [...divisionBalances.values()].sort(
          (a, b) => a.corporation.localeCompare(b.corporation) || a.division - b.division
        ),
        total_corporation_isk: corpTotal,
        window_days: windowDays,
        corporation_movements_by_type: movements,
        corporation_net_over_window: movements.reduce((sum, m) => sum + m.total, 0),
        note: 'Corporation division balances come from the newest wallet-journal entry per division, so a division with no recent entries may be stale.',
        data_refreshed: await dataFreshness(supabase, ['character-status', 'corp-wallet-journal']),
      })
    }
  )

  server.registerTool(
    'list_mercenary_dens',
    {
      title: 'List mercenary dens',
      description:
        'The Mercenary Dens the user\'s characters have deployed, each on its planet, with its current state, development and anarchy levels, infomorph count, and reinforcement timer. Answers "which dens are reinforced" or "when do my timers come out".',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        reinforced_only: z
          .boolean()
          .optional()
          .describe('Only dens with a reinforcement timer still in the future (default false)'),
      },
    },
    async ({ reinforced_only }, extra) => {
      const supabase = clientFor(extra)
      if (!supabase) return textResult('Missing bearer token.')

      type DenRow = {
        registration_id: string
        den_id: number | string
        planet_id: number | string
        type_id: number | string | null
        state: string | null
        development_level: string | null
        development_amount: number | string | null
        anarchy_level: string | null
        anarchy_amount: number | string | null
        infomorphs: number | string | null
        reinforcement_end: string | null
        status_observed_at: string | null
      }
      const [{ data: denRows }, owners] = await Promise.all([
        supabase
          .from('character_mercenary_den')
          .select(
            'registration_id, den_id, planet_id, type_id, state, development_level, development_amount, anarchy_level, anarchy_amount, infomorphs, reinforcement_end, status_observed_at'
          ),
        fetchOwnerContext(supabase),
      ])

      const dens = (denRows ?? []) as DenRow[]
      if (dens.length === 0) {
        return textResult({
          total_dens: 0,
          dens: [],
          note: 'No mercenary dens found. A character with the Mercenary Dens scope needs to be linked, or none are deployed.',
          data_refreshed: await dataFreshness(supabase, ['character-mercenary-dens']),
        })
      }

      // Planet ids resolve through the nightly SDE mirror to "<system> <roman>",
      // the same key /mercenary-dens uses.
      const planets = await getSdePlanets(dens.map((d) => Number(d.planet_id)))
      const typeNames = await getSdeTypeNames(dens.flatMap((d) => (d.type_id != null ? [Number(d.type_id)] : [])))

      const now = Date.now()
      const rows = dens
        .map((d) => {
          const planet = planets[Number(d.planet_id)]
          const reinforced = d.reinforcement_end != null && new Date(d.reinforcement_end).getTime() > now
          return {
            planet: planet?.name ?? `Planet #${d.planet_id}`,
            system: planet?.systemName ?? null,
            owner: owners.nameById.get(d.registration_id) ?? d.registration_id,
            ...(d.type_id != null && { type: typeNames[Number(d.type_id)] ?? `Type #${d.type_id}` }),
            state: d.state,
            reinforced,
            reinforcement_end: d.reinforcement_end,
            development: d.development_level,
            development_amount: d.development_amount == null ? null : Number(d.development_amount),
            anarchy: d.anarchy_level,
            anarchy_amount: d.anarchy_amount == null ? null : Number(d.anarchy_amount),
            infomorphs: d.infomorphs == null ? null : Number(d.infomorphs),
            // The den's volatile state is an observation, not a live read — it's
            // as old as the last extract run that saw it.
            status_observed_at: d.status_observed_at,
          }
        })
        .filter((r) => !reinforced_only || r.reinforced)
        .sort((a, b) => {
          // Reinforced dens first, soonest timer leading.
          const at = a.reinforcement_end ? new Date(a.reinforcement_end).getTime() : Infinity
          const bt = b.reinforcement_end ? new Date(b.reinforcement_end).getTime() : Infinity
          return at - bt || a.planet.localeCompare(b.planet)
        })

      return textResult({
        total_dens: rows.length,
        reinforced_dens: rows.filter((r) => r.reinforced).length,
        dens: rows,
        data_refreshed: await dataFreshness(supabase, ['character-mercenary-dens']),
      })
    }
  )

  server.registerTool(
    'list_fittings',
    {
      title: 'List saved ship fittings',
      description:
        "The ship fittings the user's characters have saved in the game, plus any other players have shared with them (with their corporation or alliance, or with everyone), with the hull each is for and who saved it. Filter by hull, by fit name, by owner, or by a module the fit uses — \"what Hurricane fits do I have\", \"which of my fits use a Damage Control II\". Set include_items to get each fit's full module list by slot. Note: EVE's API exposes only each pilot's *personal* fittings — corporation and alliance doctrine folders are not available, so a doctrine fit appears here only if one of their characters saved a copy and shared it (see the share controls on a fit's own page).",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        ship: z.string().optional().describe('Only fits for hulls matching this name substring, e.g. "Hurricane"'),
        name: z
          .string()
          .optional()
          .describe('Only fits whose own name or description matches this substring, e.g. "doctrine"'),
        owner: z.string().optional().describe('Only fits saved by this character (name substring)'),
        module: z
          .string()
          .optional()
          .describe('Only fits that use a module/charge/drone matching this item-name substring'),
        include_items: z
          .boolean()
          .optional()
          .describe("Include each fit's full module list, grouped by slot (default false — the listing stays compact)"),
      },
    },
    async ({ ship, name, owner, module, include_items }, extra) => {
      const supabase = clientFor(extra)
      if (!supabase) return textResult('Missing bearer token.')

      const [{ data: fittingRows }, owners] = await Promise.all([
        supabase
          .from('character_fitting')
          .select('registration_id, fitting_id, name, description, ship_type_id, items'),
        fetchOwnerContext(supabase),
      ])

      const fittings = (fittingRows ?? []) as FittingRow[]
      const freshness = await dataFreshness(supabase, ['character-fittings'])
      if (fittings.length === 0) {
        return textResult({
          total_fittings: 0,
          fittings: [],
          note: 'No saved fittings found. A character needs to be linked with the esi-fittings.read_fittings.v1 scope, and the character-fittings extract needs to have run for it.',
          data_refreshed: freshness,
        })
      }

      // character_fitting's RLS also surfaces fits shared through
      // character_fitting_share (by a corp/alliance mate, or by anyone at the
      // public level — see schema.sql) — registrations outside the caller's
      // own owner context, which fetchOwnerContext can't name. The same
      // resolver the /fitting page uses covers both, and carries the EVE
      // character id each fit's url is addressed by.
      const fittingOwners = await fetchFittingOwners(supabase, [...new Set(fittings.map((f) => f.registration_id))])
      const nameById = new Map(owners.nameById)
      fittingOwners.forEach((o, registrationId) => {
        if (o.name) nameById.set(registrationId, o.name)
      })
      const ownersWithShared: OwnerContext = { ...owners, nameById }

      const ownerFilter = resolveOwnerFilter(owner, ownersWithShared)
      if (!ownerFilter.ok) return textResult(ownerFilter.message)

      // A `module` filter resolves through the SDE search (a module name is an
      // item name like any other), then matches on type id. The hull filter
      // instead matches the *resolved* hull names of the fits themselves —
      // that set is a handful of types, so it needs no search and can't trip
      // the "too many matches" guard a broad substring would.
      const moduleFilter = await resolveTypeFilter(module)
      if (!moduleFilter.ok) return textResult(moduleFilter.message)
      const moduleTypeIds = moduleFilter.matches ? new Set(moduleFilter.matches.map((m) => m.typeID)) : null

      const typeNames = await getSdeTypeNames([
        ...fittings.map((f) => Number(f.ship_type_id)),
        ...fittings.flatMap((f) => (f.items ?? []).map((i) => Number(i.type_id))),
      ])
      const hullOf = (f: FittingRow) => typeNames[Number(f.ship_type_id)] ?? `Type #${f.ship_type_id}`

      const shipNeedle = (ship ?? '').trim().toLowerCase()
      const nameNeedle = (name ?? '').trim().toLowerCase()

      const matched = fittings.filter((f) => {
        if (ownerFilter.ownerIds && !ownerFilter.ownerIds.has(f.registration_id)) return false
        if (shipNeedle && !hullOf(f).toLowerCase().includes(shipNeedle)) return false
        if (nameNeedle && !`${f.name ?? ''} ${f.description ?? ''}`.toLowerCase().includes(nameNeedle)) return false
        if (moduleTypeIds && !(f.items ?? []).some((i) => moduleTypeIds.has(Number(i.type_id)))) return false
        return true
      })

      // Hull first, then fit name — the order /fitting lists them in.
      const sorted = sortWith<FittingRow>([ascend(hullOf), ascend((f) => (f.name ?? '').toLowerCase())], matched)

      // The module list, grouped by slot family the way the fitting window
      // shows it. Same helpers the /fitting detail page uses, so the two can't
      // disagree about what counts as a rig or a bay.
      const itemsOf = (f: FittingRow) => {
        const ordered = sortWith<FittingItem>(
          [ascend((i) => flagSortKey(i.flag)), ascend((i) => i.flag), ascend((i) => Number(i.type_id))],
          f.items ?? []
        )
        return Object.entries(groupBy((i: FittingItem) => groupForFlag(i.flag), ordered)).map(([slot, items]) => ({
          slot,
          items: (items ?? []).map((i) => ({
            item: typeNames[Number(i.type_id)] ?? `Type #${i.type_id}`,
            quantity: Number(i.quantity ?? 1),
          })),
        }))
      }

      const shown = sorted.slice(0, MAX_ROWS)
      const rows = shown.map((f) => ({
        ship: hullOf(f),
        name: f.name || `Fitting #${f.fitting_id}`,
        ...(f.description ? { description: f.description } : {}),
        owner: nameById.get(f.registration_id) ?? f.registration_id,
        item_count: (f.items ?? []).length,
        // Addressed by the owner's EVE character id, like every fitting link.
        ...(fittingOwners.get(f.registration_id)
          ? { url: fittingRoute(fittingOwners.get(f.registration_id)!.characterId, f.fitting_id) }
          : {}),
        ...(include_items ? { slots: itemsOf(f) } : {}),
      }))

      return textResult({
        total_fittings: sorted.length,
        fittings: rows,
        note: capNote(sorted.length, rows.length, 'fittings'),
        data_refreshed: freshness,
      })
    }
  )
}
