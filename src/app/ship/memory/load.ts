// The one loader behind a ship's dossier (docs/ship-memory.md, "What the ship
// knows"): reads the rows dossier.ts folds, for a character hull and a corp
// hull alike, on whatever Supabase client the caller hands in. The MCP tool
// passes the caller's bearer client, so everything here is the reader's own
// data under RLS: a buyer's dossier starts the day their extract first saw
// the hull, and the seller's docks, cargo and pilots never reach them. The
// loader narrows every read to the owners it is given besides, since the
// asset views also show a recipient the rows shared with them, and a shared
// hull is not the reader's to remember.
//
// No ESI, no new scope. Every table read here is one an extract already
// writes.
import type { SupabaseClient } from '@supabase/supabase-js'
import { uniq } from 'ramda'

import { getSdeTypeAttribute, SPECIAL_FUEL_BAY_CAPACITY } from '@/sdeDogma'
import { getSdeTypes } from '@/sdeTypes'

import { fetchAllRows } from '../../api/mcp/lib'
import { EXTRACT_INTERVAL_MS } from '../../api/mcp/memoryQuery'
import {
  type BoardingRow,
  type BuyCandidate,
  type ChildVersion,
  type ContractCandidate,
  type DossierInput,
  type HullVersion,
  type JobCandidate,
  type LineageLink,
  type Owner,
  type OwnerKind,
  type Place,
  type StackVersion,
} from './dossier'

export type Owners = { registrationIds: string[]; corporationIds: string[] }

type Hangar = {
  kind: OwnerKind
  table: 'character_asset_version' | 'corp_asset_version'
  placeTable: 'character_asset_location' | 'corp_asset_location'
  ownerColumn: 'registration_id' | 'corporation_id'
  ids: string[]
  job: 'character-assets' | 'corp-assets'
}

const hangars = (owners: Owners): Hangar[] => [
  {
    kind: 'character',
    table: 'character_asset_version',
    placeTable: 'character_asset_location',
    ownerColumn: 'registration_id',
    ids: owners.registrationIds,
    job: 'character-assets',
  },
  {
    kind: 'corporation',
    table: 'corp_asset_version',
    placeTable: 'corp_asset_location',
    ownerColumn: 'corporation_id',
    ids: owners.corporationIds,
    job: 'corp-assets',
  },
]

type VersionRow = {
  id: number | string
  item_id: number | string
  registration_id?: string
  corporation_id?: number | string
  type_id: number | string
  location_id: number | string | null
  location_flag: string | null
  quantity: number | string | null
  is_singleton: boolean | null
  name?: string | null
  is_current: boolean
  valid_from: string
  valid_until: string
}

type PlaceRow = { asset_id: number | string; location_id: number | string; location_type: string | null }

const ownerOf = (hangar: Hangar, row: VersionRow): Owner => ({
  kind: hangar.kind,
  id: String(hangar.kind === 'character' ? row.registration_id : row.corporation_id),
})

// The root places of a set of version rows, from the owner-only place table
// (null for a row whose location is another item). Read apart from the view
// so a parent link and a place never blur: the view puts both in location_id.
const placesFor = async (supabase: SupabaseClient, hangar: Hangar, rows: VersionRow[]): Promise<Map<string, Place>> => {
  const roots = rows.filter((r) => r.location_id == null).map((r) => r.id)
  if (roots.length === 0) return new Map()
  const places = await fetchAllRows<PlaceRow>((from, to) =>
    supabase
      .from(hangar.placeTable)
      .select('asset_id, location_id, location_type')
      .in('asset_id', roots)
      .range(from, to)
  )
  return new Map(places.map((p) => [String(p.asset_id), { id: Number(p.location_id), type: p.location_type }]))
}

const HULL_COLUMNS =
  'id, item_id, type_id, location_id, location_flag, quantity, is_singleton, is_current, valid_from, valid_until'

// Every version of the hull under the caller's owners in one hangar, with
// its place.
const hullVersions = async (supabase: SupabaseClient, hangar: Hangar, itemId: number): Promise<HullVersion[]> => {
  if (hangar.ids.length === 0) return []
  const columns =
    hangar.kind === 'character' ? `${HULL_COLUMNS}, name, registration_id` : `${HULL_COLUMNS}, corporation_id`
  const rows = await fetchAllRows<VersionRow>((from, to) =>
    supabase
      .from(hangar.table)
      .select(columns)
      .eq('item_id', itemId)
      .in(hangar.ownerColumn, hangar.ids)
      .order('valid_from')
      .range(from, to)
      .returns<VersionRow[]>()
  )
  const places = await placesFor(supabase, hangar, rows)
  return rows.map((r) => ({
    owner: ownerOf(hangar, r),
    typeId: Number(r.type_id),
    name: r.name ?? null,
    place: r.location_id == null ? (places.get(String(r.id)) ?? null) : null,
    parentId: r.location_id == null ? null : Number(r.location_id),
    isCurrent: r.is_current,
    validFrom: r.valid_from,
    validUntil: r.valid_until,
  }))
}

// Everything that has ever been inside the hull, from the version table (the
// view blanks a link to a parent with no open row, which a dead hull is).
const childVersions = async (supabase: SupabaseClient, hangar: Hangar, itemId: number): Promise<ChildVersion[]> => {
  if (hangar.ids.length === 0) return []
  const rows = await fetchAllRows<VersionRow>((from, to) =>
    supabase
      .from(hangar.table)
      .select(HULL_COLUMNS)
      .eq('location_id', itemId)
      .in(hangar.ownerColumn, hangar.ids)
      .order('valid_from')
      .range(from, to)
  )
  return rows.map((r) => ({
    itemId: Number(r.item_id),
    typeId: Number(r.type_id),
    flag: r.location_flag,
    quantity: Number(r.quantity ?? 1),
    isCurrent: r.is_current,
    validFrom: r.valid_from,
    validUntil: r.valid_until,
  }))
}

// Packaged stacks of the hull's type that closed around the debut: the
// reassembly rule's candidates. Bounded to the window, so this is a handful
// of rows at most.
const stacksAround = async (
  supabase: SupabaseClient,
  hangar: Hangar,
  typeId: number,
  since: string,
  until: string
): Promise<StackVersion[]> => {
  if (hangar.ids.length === 0) return []
  const columns = hangar.kind === 'character' ? `${HULL_COLUMNS}, registration_id` : `${HULL_COLUMNS}, corporation_id`
  const { data } = await supabase
    .from(hangar.table)
    .select(columns)
    .eq('type_id', typeId)
    .eq('is_singleton', false)
    .in(hangar.ownerColumn, hangar.ids)
    .gte('valid_until', since)
    .lte('valid_from', until)
    .limit(200)
    .returns<VersionRow[]>()
  const rows = (data ?? []) as VersionRow[]
  const places = await placesFor(supabase, hangar, rows)
  return rows.map((r) => ({
    itemId: Number(r.item_id),
    owner: ownerOf(hangar, r),
    place: r.location_id == null ? (places.get(String(r.id)) ?? null) : null,
    quantity: Number(r.quantity ?? 1),
    isCurrent: r.is_current,
    validFrom: r.valid_from,
    validUntil: r.valid_until,
  }))
}

type JobRow = {
  job_id: number | string
  registration_id?: string
  corporation_id?: number | string
  runs: number
  end_date: string
  status: string
}

// Delivered manufacturing jobs of the hull's type ending in the window, from
// both job tables. The tenant policy also shows a co-tenant's jobs, so the
// owner filter is explicit (seeing a job is not owning it).
const jobsAround = async (
  supabase: SupabaseClient,
  owners: Owners,
  typeId: number,
  since: string,
  until: string
): Promise<JobCandidate[]> => {
  const read = async (
    table: 'character_industry_job_over_time' | 'corp_industry_job_over_time',
    kind: OwnerKind,
    column: 'registration_id' | 'corporation_id',
    ids: string[]
  ): Promise<JobCandidate[]> => {
    if (ids.length === 0) return []
    const { data } = await supabase
      .from(table)
      .select(`job_id, ${column}, runs, end_date, status`)
      .eq('product_type_id', typeId)
      .eq('activity_id', 1)
      .in(column, ids)
      .gte('end_date', since)
      .lte('end_date', until)
      .limit(200)
      .returns<JobRow[]>()
    const rows = (data ?? []) as JobRow[]
    // A job has several versions; its facts do not change between them.
    const byJob = new Map(rows.map((r) => [String(r.job_id), r]))
    return [...byJob.values()].map((r) => ({
      jobId: Number(r.job_id),
      owner: { kind, id: String(kind === 'character' ? r.registration_id : r.corporation_id) },
      runs: Number(r.runs),
      endDate: r.end_date,
      status: r.status,
    }))
  }
  return [
    ...(await read('character_industry_job_over_time', 'character', 'registration_id', owners.registrationIds)),
    ...(await read('corp_industry_job_over_time', 'corporation', 'corporation_id', owners.corporationIds)),
  ]
}

type ContractItemRow = {
  registration_id?: string
  corporation_id?: number | string
  contract_id: number | string
  quantity: number
}
type ContractRow = {
  registration_id?: string
  corporation_id?: number | string
  contract_id: number | string
  type: string
  status: string | null
  date_accepted: string | null
  date_completed: string | null
}

// Contracts carrying the hull's type that completed (or were accepted) in
// the window, from both sides' tables.
const contractsAround = async (
  supabase: SupabaseClient,
  owners: Owners,
  typeId: number,
  since: string,
  until: string
): Promise<ContractCandidate[]> => {
  const read = async (
    itemTable: 'character_contract_item' | 'corp_contract_item',
    view: 'character_contract_with_status' | 'corp_contract_with_status',
    kind: OwnerKind,
    column: 'registration_id' | 'corporation_id',
    ids: string[]
  ): Promise<ContractCandidate[]> => {
    if (ids.length === 0) return []
    const { data: items } = await supabase
      .from(itemTable)
      .select(`${column}, contract_id, quantity`)
      .eq('type_id', typeId)
      .in(column, ids)
      .limit(500)
      .returns<ContractItemRow[]>()
    const itemRows = (items ?? []) as ContractItemRow[]
    if (itemRows.length === 0) return []
    const contractIds = uniq(itemRows.map((i) => Number(i.contract_id)))
    const { data: contracts } = await supabase
      .from(view)
      .select(`${column}, contract_id, type, status, date_accepted, date_completed`)
      .in('contract_id', contractIds)
      .in(column, ids)
      .returns<ContractRow[]>()
    const quantityOf = new Map(itemRows.map((i) => [`${i[column]}:${i.contract_id}`, Number(i.quantity)]))
    return ((contracts ?? []) as ContractRow[])
      .map((c) => ({
        contractId: Number(c.contract_id),
        owner: { kind, id: String(c[column]) },
        kind: c.type,
        status: c.status,
        at: c.date_completed ?? c.date_accepted,
        quantity: quantityOf.get(`${c[column]}:${c.contract_id}`) ?? 1,
      }))
      .filter((c) => c.at != null && c.at >= since && c.at <= until)
  }
  return [
    ...(await read(
      'character_contract_item',
      'character_contract_with_status',
      'character',
      'registration_id',
      owners.registrationIds
    )),
    ...(await read(
      'corp_contract_item',
      'corp_contract_with_status',
      'corporation',
      'corporation_id',
      owners.corporationIds
    )),
  ]
}

type BuyRow = {
  transaction_id: number | string
  registration_id: string
  date: string
  quantity: number
  unit_price: number | string
}

// Market buys of the hull's type in the window (character wallets only: the
// corp transaction table has no twin in the plan's rules).
const buysAround = async (
  supabase: SupabaseClient,
  owners: Owners,
  typeId: number,
  since: string,
  until: string
): Promise<BuyCandidate[]> => {
  if (owners.registrationIds.length === 0) return []
  const { data } = await supabase
    .from('character_wallet_transaction')
    .select('transaction_id, registration_id, date, quantity, unit_price')
    .eq('type_id', typeId)
    .eq('is_buy', true)
    .in('registration_id', owners.registrationIds)
    .gte('date', since)
    .lte('date', until)
    .limit(200)
  return ((data ?? []) as BuyRow[]).map((r) => ({
    transactionId: Number(r.transaction_id),
    owner: { kind: 'character', id: r.registration_id },
    date: r.date,
    quantity: Number(r.quantity),
    unitPrice: Number(r.unit_price),
  }))
}

// The owner's earliest asset version: the first extract wrote every item at
// once, so a hull whose debut is that run was there before we looked.
const recordStartOf = async (supabase: SupabaseClient, hangar: Hangar, ownerId: string): Promise<string | null> => {
  const { data } = await supabase
    .from(hangar.table)
    .select('valid_from')
    .eq(hangar.ownerColumn, ownerId)
    .order('valid_from')
    .limit(1)
    .maybeSingle<{ valid_from: string }>()
  return data?.valid_from ?? null
}

// When the owner's hangar was last listed successfully (lastSeen.ts: an open
// row's own stamp is only its debut).
const lastRefreshOf = async (supabase: SupabaseClient, hangar: Hangar, ownerId: string): Promise<string | null> => {
  const { data } = await supabase
    .from('heartbeat')
    .select('ended_at')
    .eq('job', hangar.job)
    .eq(hangar.ownerColumn, ownerId)
    .eq('ok', true)
    .not('ended_at', 'is', null)
    .order('ended_at', { ascending: false })
    .limit(1)
    .maybeSingle<{ ended_at: string }>()
  return data?.ended_at ?? null
}

type ShipRow = { registration_id: string; is_current: boolean; valid_from: string; valid_until: string }

const boardingsOf = async (supabase: SupabaseClient, owners: Owners, itemId: number): Promise<BoardingRow[]> => {
  if (owners.registrationIds.length === 0) return []
  const rows = await fetchAllRows<ShipRow>((from, to) =>
    supabase
      .from('character_ship_over_time')
      .select('registration_id, is_current, valid_from, valid_until')
      .eq('ship_item_id', itemId)
      .in('registration_id', owners.registrationIds)
      .order('valid_from')
      .range(from, to)
  )
  return rows.map((r) => ({
    registrationId: r.registration_id,
    isCurrent: r.is_current,
    validFrom: r.valid_from,
    validUntil: r.valid_until,
  }))
}

const iso = (ms: number): string => new Date(ms).toISOString()

// How many repackagings back the dossier follows. A hull is rarely
// reassembled once; this is a guard against a pointer loop, not a budget.
export const MAX_LINEAGE = 8

type LineageRow = { carried_from_item_id: number | string; valid_from: string }

// The earlier item ids this hull's memory came through (docs/ship-memory.md
// "Reassembly"), nearest first. The lineage pointer sits on every version of
// a carried memory, so the holder reads it on the current row under RLS, and
// an earlier id's pointer on the versions they wrote or closed — which is as
// far as their own asset history reaches anyway. A buyer's walk stops where
// the seller's record begins.
const lineageOf = async (supabase: SupabaseClient, itemId: number, acc: LineageLink[] = []): Promise<LineageLink[]> => {
  if (acc.length >= MAX_LINEAGE) return acc
  const { data } = await supabase
    .from('item_memory_over_time')
    .select('carried_from_item_id, valid_from')
    .eq('item_id', itemId)
    .not('carried_from_item_id', 'is', null)
    .order('valid_from')
    .limit(1)
    .maybeSingle<LineageRow>()
  if (data == null) return acc
  const from = Number(data.carried_from_item_id)
  if (from === itemId || acc.some((l) => l.itemId === from)) return acc
  return lineageOf(supabase, from, [...acc, { itemId: from, carriedAt: data.valid_from }])
}

// Null when the caller has never held the hull: nothing to remember.
export const loadDossierInput = async (
  supabase: SupabaseClient,
  owners: Owners,
  itemId: number
): Promise<DossierInput | null> => {
  // The hull and every id its memory was carried from: one ship, several ids.
  const lineage = await lineageOf(supabase, itemId)
  const ids = [itemId, ...lineage.map((l) => l.itemId)]
  const hullSets = await Promise.all(ids.flatMap((id) => hangars(owners).map((h) => hullVersions(supabase, h, id))))
  const hull = hullSets.flat().sort((a, b) => new Date(a.validFrom).getTime() - new Date(b.validFrom).getTime())
  if (hull.length === 0) return null

  const first = hull[0]
  const newest = hull[hull.length - 1]
  const typeId = newest.typeId
  const debutHangar = hangars(owners).find((h) => h.kind === first.owner.kind) as Hangar
  const newestHangar = hangars(owners).find((h) => h.kind === newest.owner.kind) as Hangar
  const extractIntervalMs = EXTRACT_INTERVAL_MS[first.owner.kind]
  const since = iso(new Date(first.validFrom).getTime() - extractIntervalMs)
  const until = first.validFrom

  const [children, boardings, jobs, contracts, buys, stackSets, recordStart, lastRefresh, fuelBayCapacity] =
    await Promise.all([
      Promise.all(ids.flatMap((id) => hangars(owners).map((h) => childVersions(supabase, h, id)))).then((sets) =>
        sets.flat()
      ),
      Promise.all(ids.map((id) => boardingsOf(supabase, owners, id))).then((sets) => sets.flat()),
      jobsAround(supabase, owners, typeId, since, until),
      contractsAround(supabase, owners, typeId, since, until),
      buysAround(supabase, owners, typeId, since, until),
      Promise.all(hangars(owners).map((h) => stacksAround(supabase, h, typeId, since, until))),
      recordStartOf(supabase, debutHangar, first.owner.id),
      newest.isCurrent ? lastRefreshOf(supabase, newestHangar, newest.owner.id) : Promise.resolve(null),
      getSdeTypeAttribute(typeId, SPECIAL_FUEL_BAY_CAPACITY),
    ])

  const types = await getSdeTypes(uniq(children.map((c) => c.typeId)))

  return {
    itemId,
    lineage,
    hull,
    children,
    boardings,
    jobs,
    contracts,
    buys,
    stacks: stackSets.flat(),
    recordStart,
    lastSeen: newest.isCurrent ? (lastRefresh ?? newest.validUntil) : newest.validUntil,
    volumeOf: (id) => types[id]?.volume ?? undefined,
    fuelBayCapacity,
    extractIntervalMs,
  }
}
