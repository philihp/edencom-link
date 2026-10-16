// Argument/shaping seam for the search_public_contracts MCP tool
// (docs/public-contracts.md, "Searching"). Like the other *Query.ts seams this
// module does no I/O: the tool resolves names to ids, calls the
// public_contract_search() RPC, and hands its json here — so what the tool
// sends and what it answers are unit-testable (test/publicContractQuery.test.ts).

export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 200
export const DEFAULT_ITEMS_PER_CONTRACT = 25
export const MAX_ITEMS_PER_CONTRACT = 100

export const CONTRACT_TYPES = ['item_exchange', 'auction', 'courier'] as const
export type ContractType = (typeof CONTRACT_TYPES)[number]

export const STATUSES = ['outstanding', 'closed', 'any'] as const
export type StatusFilter = (typeof STATUSES)[number]

export const SORTS = ['newest', 'price_asc', 'price_desc'] as const
export type SortOrder = (typeof SORTS)[number]

// What the tool has resolved before it asks the database: every fuzzy name is
// an id list by now, and null means "no filter".
export type ResolvedSearch = {
  typeIds: number[] | null
  regionIds: number[] | null
  systemIds: number[] | null
  issuerIds: number[] | null
  contractTypes: ContractType[] | null
  status: StatusFilter
  minPrice: number | null
  maxPrice: number | null
  issuedSince: string | null
  sort: SortOrder
  limit: number
  itemsPerContract: number
}

// Every public contract New Eden has listed is a lot of rows — the outstanding
// set alone is hundreds of thousands. A search must name something that
// narrows it: an item, a place or an issuer. A contract type or a price band
// on its own still means sorting most of the table.
export const narrowingFilterMissing = (s: Pick<ResolvedSearch, 'typeIds' | 'regionIds' | 'systemIds' | 'issuerIds'>) =>
  s.typeIds == null && s.regionIds == null && s.systemIds == null && s.issuerIds == null

export const searchParams = (s: ResolvedSearch) => ({
  type_ids: s.typeIds,
  region_ids: s.regionIds,
  system_ids: s.systemIds,
  issuer_ids: s.issuerIds,
  contract_types: s.contractTypes,
  status_filter: s.status,
  min_price: s.minPrice,
  max_price: s.maxPrice,
  issued_since: s.issuedSince,
  sort_order: s.sort,
  row_limit: Math.min(Math.max(s.limit, 1), MAX_LIMIT),
  item_limit: Math.min(Math.max(s.itemsPerContract, 0), MAX_ITEMS_PER_CONTRACT),
})

// `days` back from `now`, as the RPC's issued_since; null for no bound.
export const issuedSince = (days: number | undefined, now: Date): string | null =>
  days == null ? null : new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString()

// An issuer is named by an EVE id (character or corporation, both live in the
// same id space) or by name. Ids skip the name lookup entirely.
export type IssuerInput = { kind: 'id'; id: number } | { kind: 'name'; name: string } | null

export const parseIssuer = (raw: string | undefined): IssuerInput => {
  const trimmed = (raw ?? '').trim()
  if (trimmed === '') return null
  return /^\d+$/.test(trimmed) ? { kind: 'id', id: Number(trimmed) } : { kind: 'name', name: trimmed }
}

// ── the RPC's answer ──────────────────────────────────────────────────────

type Num = number | string | null

export type ContractItemRow = {
  type_id: number | string
  quantity: number | string
  is_included: boolean
  is_blueprint_copy: boolean | null
  material_efficiency: number | null
  time_efficiency: number | null
  runs: number | null
}

export type ContractRow = {
  contract_id: number | string
  type: string
  status: string
  status_since: string
  title: string | null
  region_id: number | string
  start_location_id: Num
  start_location_name: string | null
  start_system_id: Num
  end_location_id: Num
  end_location_name: string | null
  end_system_id: Num
  issuer_id: number | string
  issuer_corporation_id: number | string
  for_corporation: boolean
  price: Num
  buyout: Num
  reward: Num
  collateral: Num
  volume: number | null
  days_to_complete: number | null
  date_issued: string
  date_expired: string
  items_fetched: boolean
  item_lines: number
  items: ContractItemRow[]
}

export type SearchPayload = { total: number; contracts: ContractRow[] }

export type Names = {
  types: Record<number, string>
  systems: Record<number, string>
  regions: Record<number, string>
  issuers: Map<number, string>
}

const num = (v: Num): number | null => (v == null ? null : Number(v))

// Ids the tool must name before it formats: item types, the systems and
// regions the rows sit in, and both halves of every issuer.
export const idsToName = (rows: ContractRow[]) => ({
  typeIds: [...new Set(rows.flatMap((r) => r.items.map((i) => Number(i.type_id))))],
  systemIds: [
    ...new Set(
      rows.flatMap((r) => [num(r.start_system_id), num(r.end_system_id)]).filter((id): id is number => id != null)
    ),
  ],
  regionIds: [...new Set(rows.map((r) => Number(r.region_id)))],
  issuerIds: [...new Set(rows.flatMap((r) => [Number(r.issuer_id), Number(r.issuer_corporation_id)]))],
})

const place = (locationId: Num, locationName: string | null, systemId: Num, names: Names) => {
  if (locationId == null) return null
  const system = num(systemId)
  return {
    id: Number(locationId),
    // A structure nobody of ours has resolved has no name: say so rather than
    // leave the model a bare id it might take for a station.
    name: locationName ?? `Unknown structure #${locationId}`,
    system: system == null ? null : (names.systems[system] ?? `#${system}`),
  }
}

// Only the money fields the contract type has: ESI stores a courier's reward
// and collateral, an exchange's price, an auction's starting bid and buyout.
type Money = Partial<Record<'price' | 'buyout' | 'reward' | 'collateral', number>>

const money = (r: ContractRow): Money =>
  Object.fromEntries(
    (
      [
        ['price', r.price],
        ['buyout', r.buyout],
        ['reward', r.reward],
        ['collateral', r.collateral],
      ] as Array<[string, Num]>
    ).flatMap(([k, v]) => (v == null ? [] : [[k, Number(v)]]))
  )

const formatItem = (i: ContractItemRow, names: Names) => ({
  item: names.types[Number(i.type_id)] ?? `Type #${i.type_id}`,
  quantity: Number(i.quantity),
  ...(!i.is_included && { requested: true }),
  ...(i.is_blueprint_copy != null && { blueprint: i.is_blueprint_copy ? 'copy' : 'original' }),
  ...(i.material_efficiency != null && { me: i.material_efficiency }),
  ...(i.time_efficiency != null && { te: i.time_efficiency }),
  ...(i.is_blueprint_copy && i.runs != null && { runs: i.runs }),
})

const itemsNote = (r: ContractRow): string | undefined => {
  if (r.type === 'courier') return undefined
  if (!r.items_fetched) return 'Items not fetched yet.'
  if (r.item_lines > r.items.length) return `Showing ${r.items.length} of ${r.item_lines} item lines.`
  return undefined
}

export const formatContract = (r: ContractRow, names: Names) => {
  const issuerId = Number(r.issuer_id)
  const corpId = Number(r.issuer_corporation_id)
  const note = itemsNote(r)
  return {
    contract_id: Number(r.contract_id),
    type: r.type,
    status: r.status,
    status_since: r.status_since,
    ...(r.title && { title: r.title }),
    region: names.regions[Number(r.region_id)] ?? `#${r.region_id}`,
    from: place(r.start_location_id, r.start_location_name, r.start_system_id, names),
    ...(r.type === 'courier' && { to: place(r.end_location_id, r.end_location_name, r.end_system_id, names) }),
    issuer: names.issuers.get(issuerId) ?? `#${issuerId}`,
    issuer_corporation: names.issuers.get(corpId) ?? `#${corpId}`,
    ...(r.for_corporation && { for_corporation: true }),
    ...money(r),
    ...(r.volume != null && { volume_m3: r.volume }),
    ...(r.days_to_complete != null && r.type === 'courier' && { days_to_complete: r.days_to_complete }),
    date_issued: r.date_issued,
    date_expired: r.date_expired,
    ...(r.type !== 'courier' && { items: r.items.map((i) => formatItem(i, names)) }),
    ...(note && { items_note: note }),
  }
}
