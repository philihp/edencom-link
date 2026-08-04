// Root resolvers for /api/graphql. Flat by design: each Query field returns
// fully-materialized rows with names resolved here, batched once per result
// set — no nested resolvers, so no N+1 and no deep-query surface.
//
// THE LEAK GUARD (see context.ts): every table read filters
// .in('registration_id', …) from the context. In session mode that's
// redundant with RLS; in token mode the client is service-role and the filter
// is the only barrier between users.
import { GraphQLError } from 'graphql'
import { uniq } from 'ramda'

import { guessLocationRef, resolveTypeFilter } from '@/app/api/mcp/lib'
import { resolveLocations, type LocationRef, type ResolvedLocations } from '@/app/resolveLocations'
import { getSdeTypeNames } from '@/sdeTypes'
import { ASSET_CAP, LIST_CAP, clampLimit, matchOwnerIds, parseIdArg, parseSince } from './filters'
import type { GraphqlContext } from './context'

const badRequest = (message: string): never => {
  throw new GraphQLError(message, { extensions: { http: { status: 400 } } })
}

const queryFailed = (): never => {
  throw new GraphQLError('Query failed', { extensions: { http: { status: 500 } } })
}

// The registration ids a field should read for, after the optional owner-name
// filter — always a subset of the caller's own registrations.
const scopeIds = (ctx: GraphqlContext, owner: string | null | undefined): string[] => {
  const match = matchOwnerIds(owner, ctx.ownerNameById)
  if (!match.ok) return badRequest(match.message)
  return match.ids ?? ctx.registrationIds
}

// Fuzzy item-name filter → SDE type ids, with the MCP layer's "too many
// matches" guard; null means no filter.
const typeIdsFor = async (typeName: string | null | undefined): Promise<number[] | null> => {
  const filter = await resolveTypeFilter(typeName ?? undefined)
  if (!filter.ok) return badRequest(filter.message)
  return filter.matches === null ? null : filter.matches.map((m) => m.typeID)
}

// Page a filtered select up to `cap` rows — PostgREST caps a single request at
// 1000, so larger caps recurse a page at a time (tail-recursive per house style).
const PAGE_SIZE = 1000

const fetchCapped = async <T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  cap: number,
  from = 0,
  acc: T[] = []
): Promise<T[]> => {
  const to = Math.min(from + PAGE_SIZE, cap) - 1
  const { data, error } = await build(from, to)
  if (error) return queryFailed()
  const rows = data ?? []
  acc.push(...rows)
  return acc.length >= cap || rows.length < to - from + 1 ? acc : fetchCapped(build, cap, from + PAGE_SIZE, acc)
}

const typeNamesFor = async (typeIds: Array<number | string | null | undefined>): Promise<Record<number, string>> =>
  getSdeTypeNames(uniq(typeIds.filter((id): id is number | string => id != null).map(Number)))

// Batch-resolve display names for a set of location refs (station, structure,
// solar system, or a container/ship item id that falls back to a raw label).
const locationNamesFor = async (ctx: GraphqlContext, refs: Array<LocationRef | null>): Promise<ResolvedLocations> => {
  const byId = new Map((refs.filter(Boolean) as LocationRef[]).map((r) => [r.id, r]))
  return resolveLocations([...byId.values()], ctx.supabase)
}

const str = (v: number | string | null | undefined): string | null => (v == null ? null : String(v))

type AssetRow = {
  item_id: number
  registration_id: string
  type_id: number
  location_id: number | null
  location_flag: string | null
  location_type: string | null
  quantity: number | null
  is_singleton: boolean | null
  is_blueprint_copy: boolean | null
  name: string | null
}

const assetLocationRef = (row: AssetRow): LocationRef | null =>
  row.location_id == null
    ? null
    : {
        id: String(row.location_id),
        type: row.location_type === 'station' || row.location_type === 'solar_system' ? row.location_type : null,
      }

export const resolvers = {
  Query: {
    owners: (_parent: unknown, _args: unknown, ctx: GraphqlContext) =>
      [...ctx.ownerNameById].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),

    assets: async (
      _parent: unknown,
      args: { typeName?: string | null; locationId?: string | null; owner?: string | null; limit?: number | null },
      ctx: GraphqlContext
    ) => {
      const ownerIds = scopeIds(ctx, args.owner)
      const typeIds = await typeIdsFor(args.typeName)
      const location = parseIdArg(args.locationId, 'locationId')
      if (!location.ok) return badRequest(location.message)
      const cap = clampLimit(args.limit, ASSET_CAP)

      // The same filter set applies to the head-only count and the row pages.
      // The builder is untyped (no generated DB types in this repo), so `any`.
      const filtered = (query: any): any => {
        let q = query.in('registration_id', ownerIds)
        if (typeIds !== null) q = q.in('type_id', typeIds)
        if (location.id !== null) q = q.eq('location_id', location.id)
        return q
      }

      const { count, error: countError } = await filtered(
        ctx.supabase.from('character_asset').select('item_id', { count: 'exact', head: true })
      )
      if (countError) return queryFailed()
      const totalCount = count ?? 0

      const rows = await fetchCapped<AssetRow>(
        (from, to) => filtered(ctx.supabase.from('character_asset').select('*')).order('item_id').range(from, to),
        cap
      )

      const [typeNames, locations] = await Promise.all([
        typeNamesFor(rows.map((r) => r.type_id)),
        locationNamesFor(ctx, rows.map(assetLocationRef)),
      ])

      return {
        totalCount,
        truncated: totalCount > rows.length,
        rows: rows.map((r) => {
          const ref = assetLocationRef(r)
          return {
            itemId: String(r.item_id),
            typeId: String(r.type_id),
            typeName: typeNames[r.type_id] ?? null,
            quantity: String(r.quantity ?? 1),
            locationId: str(r.location_id),
            locationFlag: r.location_flag,
            locationType: r.location_type,
            locationName: ref ? locations.nameFor(ref) : null,
            isSingleton: r.is_singleton,
            isBlueprintCopy: r.is_blueprint_copy,
            name: r.name,
            ownerId: r.registration_id,
            ownerName: ctx.ownerNameById.get(r.registration_id) ?? r.registration_id,
          }
        }),
      }
    },

    blueprints: async (
      _parent: unknown,
      args: { typeName?: string | null; owner?: string | null; limit?: number | null },
      ctx: GraphqlContext
    ) => {
      const ownerIds = scopeIds(ctx, args.owner)
      const typeIds = await typeIdsFor(args.typeName)
      const cap = clampLimit(args.limit, LIST_CAP)

      type BlueprintRow = {
        item_id: number
        registration_id: string
        type_id: number
        location_id: number | null
        location_flag: string | null
        quantity: number | null
        material_efficiency: number | null
        time_efficiency: number | null
        runs: number | null
      }

      const filtered = (query: any): any => {
        const q = query.in('registration_id', ownerIds)
        return typeIds !== null ? q.in('type_id', typeIds) : q
      }

      const { count, error: countError } = await filtered(
        ctx.supabase.from('character_blueprint').select('item_id', { count: 'exact', head: true })
      )
      if (countError) return queryFailed()
      const totalCount = count ?? 0

      const rows = await fetchCapped<BlueprintRow>(
        (from, to) => filtered(ctx.supabase.from('character_blueprint').select('*')).order('item_id').range(from, to),
        cap
      )

      const [typeNames, locations] = await Promise.all([
        typeNamesFor(rows.map((r) => r.type_id)),
        locationNamesFor(
          ctx,
          rows.map((r) => guessLocationRef(r.location_id))
        ),
      ])

      return {
        totalCount,
        truncated: totalCount > rows.length,
        rows: rows.map((r) => {
          const ref = guessLocationRef(r.location_id)
          return {
            itemId: String(r.item_id),
            typeId: String(r.type_id),
            typeName: typeNames[r.type_id] ?? null,
            quantity: String(r.quantity ?? 1),
            locationId: str(r.location_id),
            locationFlag: r.location_flag,
            locationName: ref ? locations.nameFor(ref) : null,
            materialEfficiency: r.material_efficiency,
            timeEfficiency: r.time_efficiency,
            runs: r.runs,
            ownerId: r.registration_id,
            ownerName: ctx.ownerNameById.get(r.registration_id) ?? r.registration_id,
          }
        }),
      }
    },

    marketOrders: async (_parent: unknown, args: { owner?: string | null }, ctx: GraphqlContext) => {
      const ownerIds = scopeIds(ctx, args.owner)

      type OrderRow = {
        order_id: number
        registration_id: string
        type_id: number
        region_id: number
        location_id: number
        range: string
        is_buy: boolean
        price: number
        volume_total: number
        volume_remain: number
        min_volume: number | null
        escrow: number | null
        duration: number
        issued: string
      }

      const rows = await fetchCapped<OrderRow>(
        (from, to) =>
          ctx.supabase
            .from('character_order')
            .select('*')
            .in('registration_id', ownerIds)
            .order('issued', { ascending: false })
            .range(from, to),
        LIST_CAP
      )

      const [typeNames, locations] = await Promise.all([
        typeNamesFor(rows.map((r) => r.type_id)),
        locationNamesFor(
          ctx,
          rows.map((r) => guessLocationRef(r.location_id))
        ),
      ])

      return rows.map((r) => {
        const ref = guessLocationRef(r.location_id)
        return {
          orderId: String(r.order_id),
          typeId: String(r.type_id),
          typeName: typeNames[r.type_id] ?? null,
          locationId: String(r.location_id),
          locationName: ref ? locations.nameFor(ref) : null,
          regionId: String(r.region_id),
          isBuy: r.is_buy,
          price: Number(r.price),
          volumeTotal: String(r.volume_total),
          volumeRemain: String(r.volume_remain),
          minVolume: str(r.min_volume),
          escrow: r.escrow == null ? null : Number(r.escrow),
          range: r.range,
          duration: r.duration,
          issued: r.issued,
          ownerId: r.registration_id,
          ownerName: ctx.ownerNameById.get(r.registration_id) ?? r.registration_id,
        }
      })
    },

    industryJobs: async (
      _parent: unknown,
      args: { owner?: string | null; includeDelivered?: boolean | null },
      ctx: GraphqlContext
    ) => {
      const ownerIds = scopeIds(ctx, args.owner)

      type JobRow = {
        job_id: number
        registration_id: string
        activity_id: number
        blueprint_type_id: number
        product_type_id: number | null
        runs: number
        licensed_runs: number | null
        probability: number | null
        successful_runs: number | null
        status: string
        cost: number | null
        duration: number
        start_date: string
        end_date: string
        completed_date: string | null
        station_id: number | null
        facility_id: number
      }

      const rows = await fetchCapped<JobRow>((from, to) => {
        const q = ctx.supabase
          .from('character_industry_job')
          .select('*')
          .in('registration_id', ownerIds)
          .order('start_date', { ascending: false })
          .range(from, to)
        return args.includeDelivered ? q : q.neq('status', 'delivered')
      }, LIST_CAP)

      const jobLocationRef = (r: JobRow): LocationRef | null => guessLocationRef(r.station_id ?? r.facility_id)

      const [typeNames, locations] = await Promise.all([
        typeNamesFor(rows.flatMap((r) => [r.blueprint_type_id, r.product_type_id])),
        locationNamesFor(ctx, rows.map(jobLocationRef)),
      ])

      return rows.map((r) => {
        const ref = jobLocationRef(r)
        return {
          jobId: String(r.job_id),
          activityId: r.activity_id,
          blueprintTypeId: String(r.blueprint_type_id),
          blueprintTypeName: typeNames[r.blueprint_type_id] ?? null,
          productTypeId: str(r.product_type_id),
          productTypeName: r.product_type_id == null ? null : (typeNames[r.product_type_id] ?? null),
          runs: r.runs,
          licensedRuns: r.licensed_runs,
          probability: r.probability,
          successfulRuns: r.successful_runs,
          status: r.status,
          cost: r.cost == null ? null : Number(r.cost),
          duration: r.duration,
          startDate: r.start_date,
          endDate: r.end_date,
          completedDate: r.completed_date,
          stationId: str(r.station_id),
          locationName: ref ? locations.nameFor(ref) : null,
          ownerId: r.registration_id,
          ownerName: ctx.ownerNameById.get(r.registration_id) ?? r.registration_id,
        }
      })
    },

    walletBalances: async (_parent: unknown, _args: unknown, ctx: GraphqlContext) => {
      // character_wallet is an append-only balance history; one small query per
      // registration (a user links a handful of characters) grabs each latest row.
      const latest = await Promise.all(
        ctx.registrationIds.map(async (registrationId) => {
          const { data, error } = await ctx.supabase
            .from('character_wallet')
            .select('registration_id, balance, recorded_at')
            .eq('registration_id', registrationId)
            .order('recorded_at', { ascending: false })
            .limit(1)
            .maybeSingle()
          if (error) return queryFailed()
          return data as { registration_id: string; balance: number; recorded_at: string } | null
        })
      )

      return latest
        .filter((r): r is NonNullable<typeof r> => r != null)
        .map((r) => ({
          ownerId: r.registration_id,
          ownerName: ctx.ownerNameById.get(r.registration_id) ?? r.registration_id,
          balance: Number(r.balance),
          recordedAt: r.recorded_at,
        }))
        .sort((a, b) => a.ownerName.localeCompare(b.ownerName))
    },

    walletTransactions: async (
      _parent: unknown,
      args: { typeName?: string | null; owner?: string | null; since?: string | null; limit?: number | null },
      ctx: GraphqlContext
    ) => {
      const ownerIds = scopeIds(ctx, args.owner)
      const typeIds = await typeIdsFor(args.typeName)
      const since = parseSince(args.since)
      if (!since.ok) return badRequest(since.message)
      const cap = clampLimit(args.limit, LIST_CAP)

      type TransactionRow = {
        transaction_id: number
        registration_id: string
        date: string
        type_id: number
        quantity: number
        unit_price: number
        is_buy: boolean
        location_id: number
      }

      const rows = await fetchCapped<TransactionRow>((from, to) => {
        let q = ctx.supabase
          .from('character_wallet_transaction')
          .select('*')
          .in('registration_id', ownerIds)
          .order('date', { ascending: false })
          .range(from, to)
        if (typeIds !== null) q = q.in('type_id', typeIds)
        if (since.iso !== null) q = q.gte('date', since.iso)
        return q
      }, cap)

      const [typeNames, locations] = await Promise.all([
        typeNamesFor(rows.map((r) => r.type_id)),
        locationNamesFor(
          ctx,
          rows.map((r) => guessLocationRef(r.location_id))
        ),
      ])

      return rows.map((r) => {
        const ref = guessLocationRef(r.location_id)
        return {
          transactionId: String(r.transaction_id),
          date: r.date,
          typeId: String(r.type_id),
          typeName: typeNames[r.type_id] ?? null,
          quantity: String(r.quantity),
          unitPrice: Number(r.unit_price),
          isBuy: r.is_buy,
          locationId: String(r.location_id),
          locationName: ref ? locations.nameFor(ref) : null,
          ownerId: r.registration_id,
          ownerName: ctx.ownerNameById.get(r.registration_id) ?? r.registration_id,
        }
      })
    },
  },
}
