import { chain, map, uniq } from 'ramda'

import { getBlueprintsForProducts } from '@/sdeBlueprints'
import { getSdeSystem, getSdeSystems, searchSdeSystems } from '@/sdeSystems'
import { getSdeTypes } from '@/sdeTypes'
import { createClient } from '@/utils/supabase/server'

import { limboFilters } from '../../../api/graphql/assetSafety'
import { readWithinResult, withinCall, type AssetSide } from '../../../api/graphql/assetWithin'
import { formatIskValue } from '../../../isk'
import { resolveLocations, type LocationRef } from '../../../resolveLocations'
import { TypeIcon } from '../../../typeIcon'
import industryStyles from '../../industry.module.css'
import styles from '../planner.module.css'
import type { StockTarget } from '../stock-types/stockTargets'
import { locationKind, marketLines, type Listing, type OpenJob, type Stack } from './marketRows'

// The two markets the plan sells into. The home market is the sheet's
// "Home Location" setting; until the settings tab holds it, it is C-J6MT.
// Jita is a fixed system id (30000142), its region The Forge.
const HOME_SYSTEM_NAME = 'C-J6MT'
const JITA_SYSTEM_ID = 30000142
// The hourly price capture's market ids (TRACKED_MARKETS, src/gnfMarket.js).
const JITA_MARKET = 'jita'

// Open jobs: a job that will still deliver. The terminal three (delivered,
// cancelled, reverted) are the rest of the vocabulary (industryJobReconcile.js).
const OPEN_JOB_STATUSES = ['active', 'paused', 'ready']
const MANUFACTURING = 1
const REACTION = 11

// Stock that is for sale by contract: an item exchange or auction we issued
// that is still outstanding. A courier carries goods but does not sell them.
const TRADE_CONTRACT_TYPES = ['item_exchange', 'auction']

// Every stack the within functions may answer; past this a sum is refused
// rather than read short, the stance GraphQL restock takes.
const STACK_LIMIT = 5000
const PAGE_SIZE = 1000

type TargetRow = { type_id: number | string; backup: number; home: number; jita: number }
type RegistrationRow = { id: string; character_id: number | string; corporation_id: number | string | null }
type StackRow = { item_id: number | string; type_id: number | string; quantity: number | null }
type OrderRow = { type_id: number | string; region_id: number | string; volume_remain: number | string }
type ContractRow = { contract_id: number | string; start_location_id: number | string | null }
type ContractItemRow = { contract_id: number | string; type_id: number | string; quantity: number | string }
type JobRow = { product_type_id: number | string | null; runs: number }
type PriceRow = { type_id: number | string; sell_min: number | string | null }

// Drain a select past PostgREST's max_rows cap (the house tail recursion).
const fetchAllRows = async <T,>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  from = 0,
  acc: T[] = []
): Promise<T[]> => {
  const { data, error } = await build(from, from + PAGE_SIZE - 1)
  if (error || !data || data.length === 0) return acc
  acc.push(...data)
  return data.length < PAGE_SIZE ? acc : fetchAllRows(build, from + PAGE_SIZE, acc)
}

const formatShare = (share: number | null): string => (share === null ? '—' : `${Math.round(share * 100)}%`)
const formatCount = (n: number): string => n.toLocaleString('en-US')

// The market tab: every stock type with what the account holds of it, what is
// building, and what is listed for sale in the home region and in The Forge,
// against the two market targets (the sheet's Market tab).
const MarketPage = async () => {
  const supabase = await createClient()

  const [{ data: targetRows }, { data: registrations }, homeMatches, jita] = await Promise.all([
    supabase
      .from('planner_stock_target')
      .select('type_id, backup, home, jita')
      .order('created_at', { ascending: true })
      .returns<TargetRow[]>(),
    supabase.from('registration').select('id, character_id, corporation_id').returns<RegistrationRow[]>(),
    searchSdeSystems(HOME_SYSTEM_NAME, 5),
    getSdeSystem(JITA_SYSTEM_ID),
  ])
  const targets: StockTarget[] = map(
    (r) => ({ typeId: Number(r.type_id), backup: r.backup, home: r.home, jita: r.jita }),
    targetRows ?? []
  )
  const typeIds = targets.map((t) => t.typeId)
  const registrationIds = (registrations ?? []).map((r) => r.id)
  const characterIds = (registrations ?? []).map((r) => Number(r.character_id))
  const corporationIds = uniq(
    (registrations ?? []).map((r) => Number(r.corporation_id)).filter((id) => Number.isFinite(id) && id > 0)
  )
  const homeSystem = homeMatches.find((s) => s.name === HOME_SYSTEM_NAME) ?? null
  const home = homeSystem ? await getSdeSystem(homeSystem.systemID) : null
  const regions = { homeRegionId: home?.regionID ?? -1, jitaRegionId: jita?.regionID ?? -1 }

  if (typeIds.length === 0) {
    return (
      <section className={industryStyles.panel}>
        <div className={industryStyles.panelHead}>
          <span className={industryStyles.panelTitle}>market</span>
        </div>
        <p className={styles.empty}>No stock types yet. Add some on the stock types tab.</p>
      </section>
    )
  }

  // Hangar stacks of the target types, both hangars, then the stacks in asset
  // safety or an asset-safety system taken out (assetSafety.ts): they exist,
  // but they are not stock to plan with.
  const readStacks = (table: 'character_asset' | 'corp_asset', ownerColumn: string, ownerIds: readonly unknown[]) =>
    ownerIds.length === 0
      ? Promise.resolve([] as StackRow[])
      : fetchAllRows<StackRow>((from, to) =>
          supabase
            .from(table)
            .select('item_id, type_id, quantity')
            .in(ownerColumn, ownerIds)
            .in('type_id', typeIds)
            .order('item_id')
            .range(from, to)
        )
  const readLimbo = async (side: AssetSide, ownerIds: readonly string[]): Promise<StackRow[]> => {
    if (ownerIds.length === 0) return []
    const reads = await Promise.all(
      limboFilters(typeIds).map(async (filters) => {
        const { fn, args } = withinCall(side, ownerIds, filters, STACK_LIMIT)
        const { data } = await supabase.rpc(fn, args)
        return readWithinResult<StackRow>(data).rows
      })
    )
    return chain((rows) => rows, reads)
  }

  // Contracts we issued that still offer goods: ours by character, and the
  // corporation's where it was issued for the corporation.
  const readContracts = async (): Promise<
    { table: 'character_contract_item' | 'corp_contract_item'; rows: ContractRow[] }[]
  > => {
    const [own, corp] = await Promise.all([
      registrationIds.length === 0
        ? Promise.resolve({ data: [] as ContractRow[] })
        : supabase
            .from('character_contract_with_status')
            .select('contract_id, start_location_id')
            .in('registration_id', registrationIds)
            .in('issuer_id', characterIds)
            .eq('for_corporation', false)
            .eq('status', 'outstanding')
            .in('type', TRADE_CONTRACT_TYPES)
            .returns<ContractRow[]>(),
      corporationIds.length === 0
        ? Promise.resolve({ data: [] as ContractRow[] })
        : supabase
            .from('corp_contract_with_status')
            .select('contract_id, start_location_id')
            .in('corporation_id', corporationIds)
            .in('issuer_corporation_id', corporationIds)
            .eq('for_corporation', true)
            .eq('status', 'outstanding')
            .in('type', TRADE_CONTRACT_TYPES)
            .returns<ContractRow[]>(),
    ])
    return [
      { table: 'character_contract_item', rows: own.data ?? [] },
      { table: 'corp_contract_item', rows: corp.data ?? [] },
    ]
  }

  const [
    ownStacks,
    corpStacks,
    ownLimbo,
    corpLimbo,
    { data: orders },
    contracts,
    ownJobs,
    corpJobs,
    blueprints,
    { data: priceRows },
    types,
  ] = await Promise.all([
    readStacks('character_asset', 'registration_id', registrationIds),
    readStacks('corp_asset', 'corporation_id', corporationIds),
    readLimbo('character', registrationIds),
    readLimbo('corporation', corporationIds.map(String)),
    supabase
      .from('character_order')
      .select('type_id, region_id, volume_remain')
      .eq('is_buy', false)
      .in('type_id', typeIds)
      .returns<OrderRow[]>(),
    readContracts(),
    supabase
      .from('character_industry_job')
      .select('product_type_id, runs')
      .in('registration_id', registrationIds)
      .in('product_type_id', typeIds)
      .in('status', OPEN_JOB_STATUSES)
      .in('activity_id', [MANUFACTURING, REACTION])
      .returns<JobRow[]>(),
    corporationIds.length === 0
      ? Promise.resolve({ data: [] as JobRow[] })
      : supabase
          .from('corp_industry_job')
          .select('product_type_id, runs')
          .in('corporation_id', corporationIds)
          .in('product_type_id', typeIds)
          .in('status', OPEN_JOB_STATUSES)
          .in('activity_id', [MANUFACTURING, REACTION])
          .returns<JobRow[]>(),
    getBlueprintsForProducts(typeIds),
    supabase
      .from('market_price')
      .select('type_id, sell_min')
      .eq('market', JITA_MARKET)
      .in('type_id', typeIds)
      .returns<PriceRow[]>(),
    getSdeTypes(typeIds),
  ])

  const limbo = new Set([...ownLimbo, ...corpLimbo].map((s) => String(s.item_id)))
  const stacks: Stack[] = [...ownStacks, ...corpStacks]
    .filter((s) => !limbo.has(String(s.item_id)))
    .map((s) => ({ typeId: Number(s.type_id), quantity: Number(s.quantity ?? 0) }))

  // Each contract's region: its start location → system → region.
  const contractRows = chain((c) => c.rows, contracts)
  const locationRefs: LocationRef[] = uniq(
    contractRows.map((c) => Number(c.start_location_id)).filter((id) => Number.isFinite(id) && id > 0)
  ).map((id) => ({ id: String(id), type: locationKind(id) }))
  const locations = await resolveLocations(locationRefs, supabase)
  const systemIds = uniq(locationRefs.map((l) => locations.systemIdFor(l)).filter((id): id is number => id != null))
  const systems = await getSdeSystems(systemIds)
  const regionOf = (locationId: number | string | null): number | null => {
    if (locationId == null) return null
    const systemId = locations.systemIdFor({ id: String(locationId), type: locationKind(Number(locationId)) })
    return systemId == null ? null : (systems[systemId]?.regionID ?? null)
  }

  const contractItems = await Promise.all(
    contracts.map(async ({ table, rows }) => {
      if (rows.length === 0) return [] as Listing[]
      const { data } = await supabase
        .from(table)
        .select('contract_id, type_id, quantity')
        .in(
          'contract_id',
          rows.map((r) => r.contract_id)
        )
        .in('type_id', typeIds)
        .eq('is_included', true)
        .returns<ContractItemRow[]>()
      const regionByContract = new Map(rows.map((r) => [String(r.contract_id), regionOf(r.start_location_id)]))
      return (data ?? []).map((i) => ({
        typeId: Number(i.type_id),
        regionId: regionByContract.get(String(i.contract_id)) ?? null,
        quantity: Number(i.quantity),
      }))
    })
  )
  const listings: Listing[] = [
    ...(orders ?? []).map((o) => ({
      typeId: Number(o.type_id),
      regionId: Number(o.region_id),
      quantity: Number(o.volume_remain),
    })),
    ...chain((l) => l, contractItems),
  ]

  const unitsPerRun = (typeId: number): number => blueprints[typeId]?.productQuantity ?? 1
  const jobs: OpenJob[] = [...(ownJobs.data ?? []), ...(corpJobs.data ?? [])]
    .filter((j) => j.product_type_id != null)
    .map((j) => ({ typeId: Number(j.product_type_id), units: j.runs * unitsPerRun(Number(j.product_type_id)) }))

  const jitaAsk = new Map<number, number>(
    (priceRows ?? []).filter((p) => p.sell_min !== null).map((p) => [Number(p.type_id), Number(p.sell_min)])
  )

  const lines = marketLines(targets, stacks, listings, jobs, jitaAsk, regions)

  return (
    <section className={industryStyles.panel}>
      <div className={industryStyles.panelHead}>
        <span className={industryStyles.panelTitle}>market</span>
        <span className={styles.panelCount}>
          {home?.name ?? HOME_SYSTEM_NAME} · {home?.regionName ?? '?'} and {jita?.regionName ?? 'The Forge'}
        </span>
      </div>
      <div className={industryStyles.tableScroll}>
        <table className={industryStyles.table}>
          <thead>
            <tr>
              <th>type</th>
              <th className={industryStyles.num}>home target</th>
              <th className={industryStyles.num}>jita target</th>
              <th className={industryStyles.num}>inventory</th>
              <th className={industryStyles.num}>in flight</th>
              <th className={industryStyles.num}>home listed</th>
              <th className={industryStyles.num}>jita listed</th>
              <th className={industryStyles.num}>home market</th>
              <th className={industryStyles.num}>jita market</th>
              <th className={industryStyles.num}>import price</th>
              <th className={industryStyles.num}>build price</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.typeId} className={industryStyles.row}>
                <td>
                  <span className={styles.typeCell}>
                    <TypeIcon id={l.typeId} size={20} categoryID={types[l.typeId]?.categoryID ?? undefined} />
                    {types[l.typeId]?.name ?? `#${l.typeId}`}
                  </span>
                </td>
                <td className={industryStyles.num}>{formatCount(l.homeTarget)}</td>
                <td className={industryStyles.num}>{formatCount(l.jitaTarget)}</td>
                <td className={industryStyles.num}>{formatCount(l.inventory)}</td>
                <td className={industryStyles.num}>{formatCount(l.inFlight)}</td>
                <td className={industryStyles.num}>{formatCount(l.homeListed)}</td>
                <td className={industryStyles.num}>{formatCount(l.jitaListed)}</td>
                <td className={industryStyles.num}>{formatShare(l.homeShare)}</td>
                <td className={industryStyles.num}>{formatShare(l.jitaShare)}</td>
                <td className={industryStyles.num}>{l.importPrice === null ? '—' : formatIskValue(l.importPrice)}</td>
                <td className={`${industryStyles.num} ${industryStyles.faint}`}>—</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={industryStyles.panelFoot}>
        inventory: every hangar, asset-safety stock left out · in flight: open manufacturing and reaction jobs · listed:
        sell orders and outstanding item-exchange or auction contracts we issued, by region · market: listed ÷ target ·
        import price: Jita best ask · build price comes with the industry tab
      </div>
    </section>
  )
}

export default MarketPage
