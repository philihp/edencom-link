import { redirect } from 'next/navigation'
import { chain, concat, filter, forEach, map, splitEvery, uniq } from 'ramda'

import { getBlueprintsByTypeIDs, type Blueprint } from '@/sdeBlueprints'
import { createClient } from '@/utils/supabase/server'

import { establishedUser } from '../account/lib/establishedUser'
import { fetchOwners } from '../owners'
import { fetchStationNames } from '../stationNames'
import { fetchTypeNames } from '../typeNames'
import { IndustryView } from './industryView'
import { jobLift, liftFamily, liftRate, splitPrice, type LiftJob } from './lift'

// The whole job history, not just what is active: the lift-rate chart digs
// back to the oldest job on record, and a scoped moment lists the jobs that
// were running then. Both views keep every job they saw finish (a terminal
// row stays is_current — see the SCD-2 notes in CLAUDE.md), so the views are
// the history.
type JobRow = {
  job_id: number | string
  activity_id: number
  blueprint_id: number | string
  blueprint_type_id: number | string
  product_type_id: number | string | null
  runs: number
  cost: number | string | null
  status: string
  start_date: string
  end_date: string
  station_id: number | string | null
  facility_id: number | string | null
  registration_id?: string
  corporation_id?: number | string
}

const JOB_COLUMNS =
  'job_id, activity_id, blueprint_id, blueprint_type_id, product_type_id, runs, cost, status, start_date, end_date, station_id, facility_id'

const PAGE_SIZE = 1000
const RPC_BATCH = 500
// Blueprint rows come back one per *version*, so a batch of items has to leave
// room under max_rows for a few versions each.
const BLUEPRINT_BATCH = 200

// The market every lift is priced in. 'jita' is one of the two markets the
// hourly market-prices capture tracks (TRACKED_MARKETS in src/gnfMarket.js).
const MARKET = 'jita'

const HOUR = 3_600_000

// Drain a select past PostgREST's max_rows cap by recursing to the next page
// until a short page signals the end — the house shape for an unbounded pull
// (cf. src/app/structure/page.tsx).
const fetchAllRows = async <T,>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  from = 0,
  acc: readonly T[] = []
): Promise<T[]> => {
  const { data, error } = await build(from, from + PAGE_SIZE - 1)
  if (error || !data || data.length === 0) return [...acc]
  const rows = concat(acc, data)
  return data.length < PAGE_SIZE ? rows : fetchAllRows(build, from + PAGE_SIZE, rows)
}

type PriceAt = {
  type_id: number | string
  as_of: string
  buy_max: number | string | null
  sell_min: number | string | null
  exact: boolean
}

type BlueprintVersion = { item_id: number | string; material_efficiency: number | null; valid_until: string }

// A probe's moment: the install hour. Prices are captured hourly, so finer
// than that buys nothing, and rounding lets jobs installed in the same hour
// share one answer.
const probeMoment = (startIso: string): string => new Date(Math.floor(Date.parse(startIso) / HOUR) * HOUR).toISOString()

const probeKey = (typeId: number, asOf: string) => `${typeId}@${asOf}`

const IndustryPage = async () => {
  const supabase = await createClient()

  const user = await establishedUser(supabase)
  if (!user) {
    redirect('/')
  }

  const fetchJobs = (table: 'character_industry_job' | 'corp_industry_job') =>
    fetchAllRows<JobRow>((from, to) =>
      supabase
        .from(table)
        .select(`${JOB_COLUMNS}, ${table === 'corp_industry_job' ? 'corporation_id' : 'registration_id'}`)
        .order('job_id', { ascending: true })
        .range(from, to)
        // The typed query parser gives up past a dozen columns; the shape is
        // pinned explicitly instead.
        .returns<JobRow[]>()
    )

  const [characterJobs, corpJobs, owners] = await Promise.all([
    fetchJobs('character_industry_job'),
    fetchJobs('corp_industry_job'),
    fetchOwners(),
  ])

  // Union both sources under a single owner id per job. A corp job installed
  // by one of our own characters shows up in both extracts under the same
  // job_id; the corp row wins so the owner names who the job belongs to.
  type OwnedJob = JobRow & { owner_id: string }
  const corpRows: OwnedJob[] = map((j: JobRow) => ({ ...j, owner_id: String(j.corporation_id) }), corpJobs)
  const corpJobIds = new Set(map((j) => String(j.job_id), corpRows))
  const characterRows: OwnedJob[] = map(
    (j: JobRow) => ({ ...j, owner_id: String(j.registration_id) }),
    filter((j: JobRow) => !corpJobIds.has(String(j.job_id)), characterJobs)
  )
  const rows = concat(characterRows, corpRows)

  // ── Pricing ───────────────────────────────────────────────────────────────
  // Manufacturing and reaction jobs carry a bill (sde_blueprint_product) and a
  // product; both are priced at the install hour by market_price_at(). ME
  // comes from the blueprint item the job ran, looked up through the blueprint
  // history (a consumed copy has a closed row, never a current one).
  const measurable = filter((j: OwnedJob) => liftFamily(Number(j.activity_id)) !== 'research', rows)
  const blueprints = await getBlueprintsByTypeIDs(map((j: OwnedJob) => Number(j.blueprint_type_id), measurable))

  const blueprintItemIds = uniq(
    map(
      (j: OwnedJob) => Number(j.blueprint_id),
      filter((j: OwnedJob) => liftFamily(Number(j.activity_id)) === 'manufacturing', measurable)
    )
  ).filter(Number.isFinite)
  const versionBatches = blueprintItemIds.length
    ? await Promise.all(
        chain(
          (batch: number[]) => [
            supabase
              .from('character_blueprint_over_time')
              .select('item_id, material_efficiency, valid_until')
              .in('item_id', batch)
              .order('valid_until', { ascending: false }),
            supabase
              .from('corp_blueprint_over_time')
              .select('item_id, material_efficiency, valid_until')
              .in('item_id', batch)
              .order('valid_until', { ascending: false }),
          ],
          splitEvery(BLUEPRINT_BATCH, blueprintItemIds)
        )
      )
    : []
  // Latest version per item wins (each batch arrived newest first); a
  // blueprint we never held reads as ME 0.
  const meOf = new Map<string, number>()
  forEach(
    (v: BlueprintVersion) => {
      const key = String(v.item_id)
      if (!meOf.has(key) && v.material_efficiency != null) meOf.set(key, Number(v.material_efficiency))
    },
    chain(({ data }) => (data ?? []) as BlueprintVersion[], versionBatches)
  )

  // One probe per (type, install hour) across every measurable job's product
  // and bill; the Map de-duplicates jobs installed in the same hour.
  const probes = new Map<string, { type_id: number; as_of: string }>()
  forEach((j: OwnedJob) => {
    const bp: Blueprint | undefined = blueprints[Number(j.blueprint_type_id)]
    if (!bp) return
    const asOf = probeMoment(j.start_date)
    forEach(
      (typeId: number) => {
        probes.set(probeKey(typeId, asOf), { type_id: typeId, as_of: asOf })
      },
      [bp.productTypeID, ...map((m) => m.typeID, bp.materials)]
    )
  }, measurable)
  const priced =
    probes.size > 0
      ? await supabase.rpc('market_price_at', { market_id: MARKET, probes: [...probes.values()] })
      : { data: [] as PriceAt[], error: null }
  // A failed lookup is told apart from a bill the market cannot price: the
  // first is reported as such, the second as the unpriced count.
  const pricingFailed = priced.error != null
  if (priced.error) console.error(`[industry] market_price_at failed: ${priced.error.message}`)
  const priceAt = new Map<string, number | null>()
  forEach(
    (p: PriceAt) => {
      priceAt.set(
        probeKey(Number(p.type_id), new Date(p.as_of).toISOString()),
        splitPrice(p.buy_max == null ? null : Number(p.buy_max), p.sell_min == null ? null : Number(p.sell_min))
      )
    },
    (priced.data ?? []) as PriceAt[]
  )

  const jobs: LiftJob[] = map((j: OwnedJob): LiftJob => {
    const start = Date.parse(j.start_date)
    const end = Date.parse(j.end_date)
    const family = liftFamily(Number(j.activity_id))
    const bp = family === 'research' ? undefined : blueprints[Number(j.blueprint_type_id)]
    let lift: number | null = null
    if (bp) {
      const asOf = probeMoment(j.start_date)
      const price = (typeId: number) => priceAt.get(probeKey(typeId, asOf)) ?? null
      lift = jobLift({
        runs: Number(j.runs),
        cost: j.cost == null ? null : Number(j.cost),
        product: { quantity: bp.productQuantity, price: price(bp.productTypeID) },
        materials: map((m) => ({ quantity: m.quantity, price: price(m.typeID) }), bp.materials),
        me: family === 'manufacturing' ? (meOf.get(String(j.blueprint_id)) ?? 0) : 0,
      })
    }
    const stationId = j.station_id ?? j.facility_id
    return {
      id: String(j.job_id),
      ownerId: j.owner_id,
      family,
      activityId: Number(j.activity_id),
      productTypeId: j.product_type_id == null ? null : Number(j.product_type_id),
      blueprintTypeId: Number(j.blueprint_type_id),
      runs: Number(j.runs),
      status: j.status,
      start,
      end,
      stationId: stationId == null ? null : String(stationId),
      lift,
      rate: liftRate(lift, start, end),
    }
  }, rows)

  // ── Names ─────────────────────────────────────────────────────────────────
  // Products for the list and the hover card, blueprints for the research
  // jobs that have no product; stations the way the assets page resolves them
  // (our corp's structures win, then ESI-resolved player structures, then the
  // NPC station cache).
  const typeIds = uniq(
    concat(
      chain((j: LiftJob) => (j.productTypeId != null ? [j.productTypeId] : []), jobs),
      map((j) => j.blueprintTypeId, jobs)
    )
  )
  const stationIds = uniq(chain((j: LiftJob) => (j.stationId != null ? [Number(j.stationId)] : []), jobs)).filter(
    Number.isFinite
  )
  const [typeNames, { data: corpStructures }, playerStructureBatches, npcStationNames] = await Promise.all([
    fetchTypeNames(typeIds),
    supabase.from('corp_structure').select('structure_id, name'),
    Promise.all(
      map(
        (batch: number[]) => supabase.from('universe_structure').select('structure_id, name').in('structure_id', batch),
        splitEvery(RPC_BATCH, stationIds)
      )
    ),
    fetchStationNames(stationIds),
  ])
  type Named = { structure_id: number | string; name: string | null }
  const structureNames = Object.fromEntries(
    map(
      (s: Named) => [String(s.structure_id), s.name as string],
      filter(
        (s: Named) => s.name != null,
        concat(
          chain(({ data }) => (data ?? []) as Named[], playerStructureBatches),
          (corpStructures ?? []) as Named[]
        )
      )
    )
  )
  const stationNames: Record<string, string> = { ...npcStationNames, ...structureNames }

  const unpriced = filter((j: LiftJob) => j.family !== 'research' && j.lift == null, jobs).length

  return (
    <IndustryView
      jobs={jobs}
      owners={owners}
      typeNames={typeNames}
      stationNames={stationNames}
      initialNow={Date.now()}
      unpriced={unpriced}
      pricingFailed={pricingFailed}
    />
  )
}
export default IndustryPage
