// The one loader behind /blueprint/[itemId] (docs/item-pages.md): the
// blueprint row, the jobs it ran, the names those need, the pricing, and the
// copy-origin inference — everything on the caller's cookie session, so RLS
// scopes it the way every other page is scoped. A blueprint lives in exactly
// one hangar; both are asked and the character row wins, as the ship page
// does.
//
// No ESI, no new scope. Every table read here is one an extract already
// writes.
import type { SupabaseClient } from '@supabase/supabase-js'
import { chain, concat, filter, map, splitEvery, uniq } from 'ramda'

import { getBlueprintsByTypeIDs, type Blueprint } from '@/sdeBlueprints'
import { getSdeType, type SdeType } from '@/sdeTypes'

import { fetchAllRows } from '../../api/mcp/lib'
import { fetchOwners } from '../../owners'
import type { Owner, Owners } from '../../ownerFilter'
import { readShipMemory, type ShipMemory } from '../../ship/memory/read'
import { fetchStationNames } from '../../stationNames'
import { fetchTypeNames } from '../../typeNames'
import {
  ACTIVITY,
  dedupeJobs,
  foldHistory,
  type HistoryJob,
  type HistoryPricing,
  type HistoryTotals,
  type RunRow,
} from './history'
import { inferCopyOrigin, type Origin, type OriginJob } from './origin'

type OwnerKind = 'character' | 'corporation'

type BlueprintRow = {
  item_id: number | string
  registration_id?: string
  corporation_id?: number | string
  type_id: number | string
  location_id: number | string | null
  location_flag: string | null
  quantity: number | string | null
  material_efficiency: number | null
  time_efficiency: number | null
  runs: number | null
  is_current: boolean
  valid_from: string
  valid_until: string
}

export type BlueprintItem = {
  itemId: number
  typeId: number
  type: SdeType | null
  // ESI's quantity: −1 an original, −2 a copy, a positive count a stack.
  isCopy: boolean
  me: number | null
  te: number | null
  // Runs left on a copy; null for an original.
  runsLeft: number | null
  owner: { kind: OwnerKind; id: string; name: string }
  locationId: number | null
  locationFlag: string | null
  // Whether the caller still holds it: the newest version is open.
  held: boolean
  // The newest version's clock: its debut while open, when it was closed
  // otherwise.
  lastSeen: string
  // The item's earliest version in the caller's record.
  debut: string
}

export type BlueprintPageData = {
  item: BlueprintItem
  rows: RunRow[]
  totals: HistoryTotals
  // What one run of this blueprint makes, from the SDE; null for a blueprint
  // with no manufacturing or reaction activity.
  product: Blueprint | null
  origin: Origin | null
  memory: ShipMemory | null
  names: {
    types: Record<number, string>
    locations: Record<string, string>
    owners: Record<string, string>
  }
  owners: Owners
  // When CCP's adjusted prices were last pulled: the moment the EIVs are
  // priced at (docs/item-pages.md, "EIV at that time").
  pricedAt: string | null
}

const BLUEPRINT_COLUMNS =
  'item_id, type_id, location_id, location_flag, quantity, material_efficiency, time_efficiency, runs, is_current, valid_from, valid_until'

const JOB_COLUMNS =
  'job_id, activity_id, blueprint_type_id, product_type_id, runs, licensed_runs, successful_runs, status, start_date, end_date, completed_date, station_id, facility_id'

type JobRow = Omit<HistoryJob, 'owner_id'> & { registration_id?: string; corporation_id?: number | string }

// Every version of the item in one hangar's blueprint history, oldest first.
const versions = async (supabase: SupabaseClient, kind: OwnerKind, itemId: number): Promise<BlueprintRow[]> =>
  fetchAllRows<BlueprintRow>((from, to) =>
    supabase
      .from(kind === 'character' ? 'character_blueprint_over_time' : 'corp_blueprint_over_time')
      .select(`${BLUEPRINT_COLUMNS}, ${kind === 'character' ? 'registration_id' : 'corporation_id'}`)
      .eq('item_id', itemId)
      .order('valid_from')
      .range(from, to)
      .returns<BlueprintRow[]>()
  )

// The owner's earliest blueprint version of any item: when their record
// began, for the origin rule's "predates the record".
const recordStart = async (supabase: SupabaseClient, kind: OwnerKind, ownerId: string): Promise<string | null> => {
  const { data } = await supabase
    .from(kind === 'character' ? 'character_blueprint_over_time' : 'corp_blueprint_over_time')
    .select('valid_from')
    .eq(kind === 'character' ? 'registration_id' : 'corporation_id', ownerId)
    .order('valid_from')
    .limit(1)
    .maybeSingle<{ valid_from: string }>()
  return data?.valid_from ?? null
}

// The jobs one view holds for a blueprint item — or, for the origin rule,
// for a blueprint TYPE in a window — narrowed to the caller's own owners
// (the views also show co-tenants' jobs, as /industry notes).
// `narrow` adds the query's own predicate to the select (an item id, or a
// type and a window); PostgREST's builder types are too wide to name here.
const fetchJobs = async (
  supabase: SupabaseClient,
  kind: OwnerKind,
  own: Set<string>,
  narrow: (q: any) => any
): Promise<HistoryJob[]> => {
  const table = kind === 'character' ? 'character_industry_job' : 'corp_industry_job'
  const ownerColumn = kind === 'character' ? 'registration_id' : 'corporation_id'
  const rows = await fetchAllRows<JobRow>((from, to) =>
    narrow(supabase.from(table).select(`${JOB_COLUMNS}, ${ownerColumn}`))
      .order('job_id', { ascending: true })
      .range(from, to)
      .returns()
  )
  return map(
    (j: JobRow): HistoryJob => ({
      ...j,
      owner_id: String(kind === 'character' ? j.registration_id : j.corporation_id),
    }),
    filter((j: JobRow) => own.has(String(kind === 'character' ? j.registration_id : j.corporation_id)), rows)
  )
}

const ADJUSTED_PRICE_BATCH = 500

// How far back before a copy's debut its job could have ended: a finished
// job waits in "ready" until delivered, so this is wider than the delivery
// window the pure rule applies (ORIGIN_WINDOW_MS).
const ORIGIN_READ_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

// CCP's adjusted prices for a set of types, latest only (docs/item-pages.md
// defers the history to PR 4), with the newest capture's clock.
const adjustedPrices = async (
  supabase: SupabaseClient,
  typeIds: number[]
): Promise<{ prices: Map<number, number>; recordedAt: string | null }> => {
  const batches = await Promise.all(
    map(
      (batch: number[]) =>
        supabase.from('market_adjusted_price').select('type_id, adjusted_price, recorded_at').in('type_id', batch),
      splitEvery(ADJUSTED_PRICE_BATCH, typeIds)
    )
  )
  type Row = { type_id: number | string; adjusted_price: number | string; recorded_at: string }
  const rows = chain(({ data }) => (data ?? []) as Row[], batches)
  const prices = new Map(map((r: Row) => [Number(r.type_id), Number(r.adjusted_price)] as const, rows))
  const recordedAt = rows.reduce<string | null>((m, r) => (m == null || r.recorded_at > m ? r.recorded_at : m), null)
  return { prices, recordedAt }
}

export const loadBlueprintPage = async (
  supabase: SupabaseClient,
  itemId: number
): Promise<BlueprintPageData | null> => {
  const [characterVersions, corpVersions, owners] = await Promise.all([
    versions(supabase, 'character', itemId),
    versions(supabase, 'corporation', itemId),
    fetchOwners(supabase),
  ])
  const kind: OwnerKind | null =
    characterVersions.length > 0 ? 'character' : corpVersions.length > 0 ? 'corporation' : null
  if (kind == null) return null
  const all = kind === 'character' ? characterVersions : corpVersions
  const newest = all[all.length - 1]
  const ownerId = String(kind === 'character' ? newest.registration_id : newest.corporation_id)
  const ownerNames = Object.fromEntries(
    map((o: Owner) => [o.id, o.name] as const, concat(owners.characters, owners.corporations))
  )

  const type = await getSdeType(Number(newest.type_id))
  const item: BlueprintItem = {
    itemId,
    typeId: Number(newest.type_id),
    type,
    isCopy: Number(newest.quantity) === -2 || (newest.runs != null && newest.runs > 0),
    me: newest.material_efficiency,
    te: newest.time_efficiency,
    runsLeft: newest.runs != null && newest.runs > 0 ? newest.runs : null,
    owner: { kind, id: ownerId, name: ownerNames[ownerId] ?? `#${ownerId}` },
    locationId: newest.location_id == null ? null : Number(newest.location_id),
    locationFlag: newest.location_flag,
    held: newest.is_current,
    lastSeen: newest.is_current ? newest.valid_from : newest.valid_until,
    debut: all[0].valid_from,
  }

  // ── Runs ─────────────────────────────────────────────────────────────────
  // Both views, by blueprint_id (indexed since 20261102220819), the caller's
  // own owners only, a job both list counted once for the corporation.
  const byItem = (q: any) => q.eq('blueprint_id', itemId)
  const [characterJobs, corpJobs, blueprints, memory] = await Promise.all([
    fetchJobs(supabase, 'character', new Set(map((o) => o.id, owners.characters)), byItem),
    fetchJobs(supabase, 'corporation', new Set(map((o) => o.id, owners.corporations)), byItem),
    getBlueprintsByTypeIDs([item.typeId]),
    readShipMemory(supabase, itemId),
  ])
  const jobs = dedupeJobs(characterJobs, corpJobs)
  const product: Blueprint | null = blueprints[item.typeId] ?? null

  const { prices, recordedAt } = await adjustedPrices(
    supabase,
    product == null ? [] : map((m) => m.typeID, product.materials)
  )
  const pricing: HistoryPricing = {
    bills: product == null ? {} : { [item.typeId]: product.materials },
    products:
      product == null
        ? {}
        : { [item.typeId]: { productTypeID: product.productTypeID, productQuantity: product.productQuantity } },
    // Latest-only today; PR 4 prices at the moment.
    priceAt: (typeId) => prices.get(typeId) ?? null,
  }
  const { rows, totals } = foldHistory(jobs, pricing)

  // ── Origin, for a copy ───────────────────────────────────────────────────
  // The caller's copy and invention jobs of this type delivered in the window
  // before the debut; the pure rule picks among them.
  let origin: Origin | null = null
  if (item.isCopy) {
    // A job ends before it is delivered, sometimes by weeks (it sits "ready"),
    // so the read bounds end_date loosely and the pure rule judges delivery.
    const windowStart = new Date(Date.parse(item.debut) - ORIGIN_READ_WINDOW_MS).toISOString()
    const byType = (q: any) =>
      q
        .in('activity_id', [ACTIVITY.copying, ACTIVITY.invention])
        .or(`blueprint_type_id.eq.${item.typeId},product_type_id.eq.${item.typeId}`)
        .gte('end_date', windowStart)
        .lte('end_date', item.debut)
    const [start, characterCandidates, corpCandidates] = await Promise.all([
      recordStart(supabase, kind, ownerId),
      fetchJobs(supabase, 'character', new Set(map((o) => o.id, owners.characters)), byType),
      fetchJobs(supabase, 'corporation', new Set(map((o) => o.id, owners.corporations)), byType),
    ])
    origin = inferCopyOrigin({
      typeId: item.typeId,
      debut: item.debut,
      recordStart: start,
      ownerKind: kind,
      jobs: dedupeJobs(characterCandidates, corpCandidates) as OriginJob[],
    })
  }

  // ── Names ────────────────────────────────────────────────────────────────
  const typeIds = uniq(
    concat(
      [item.typeId, ...(product ? [product.productTypeID] : [])],
      chain((r: RunRow) => ('typeId' in r.made && r.made.typeId != null ? [r.made.typeId] : []), rows)
    )
  )
  const locationIds = uniq(
    filter(
      (id: number) => Number.isFinite(id),
      concat(
        [
          item.locationId ?? NaN,
          origin != null && 'locationId' in origin && origin.locationId != null ? Number(origin.locationId) : NaN,
        ],
        chain((r: RunRow) => (r.locationId != null ? [Number(r.locationId)] : []), rows)
      )
    )
  )
  const [types, locations] = await Promise.all([fetchTypeNames(typeIds), locationNames(supabase, locationIds)])

  return {
    item,
    rows,
    totals,
    product,
    origin,
    memory,
    names: { types, locations, owners: ownerNames },
    owners,
    pricedAt: recordedAt,
  }
}

// Stations the way /industry names them: our corp's structures win, then the
// public structure directory, then the NPC station cache.
const locationNames = async (supabase: SupabaseClient, ids: number[]): Promise<Record<string, string>> => {
  if (ids.length === 0) return {}
  type Named = { structure_id: number | string; name: string | null }
  const [{ data: corpStructures }, { data: publicStructures }, stations] = await Promise.all([
    supabase.from('corp_structure').select('structure_id, name').in('structure_id', ids),
    supabase.from('universe_structure').select('structure_id, name').in('structure_id', ids),
    fetchStationNames(ids, supabase),
  ])
  const structures = Object.fromEntries(
    map(
      (s: Named) => [String(s.structure_id), s.name as string] as const,
      filter(
        (s: Named) => s.name != null,
        concat((publicStructures ?? []) as Named[], (corpStructures ?? []) as Named[])
      )
    )
  )
  return { ...Object.fromEntries(map(([id, name]) => [String(id), name], Object.entries(stations))), ...structures }
}
