import Link from 'next/link'
import { redirect } from 'next/navigation'
import {
  ascend,
  chain,
  concat,
  descend,
  filter,
  forEach,
  isNil,
  map,
  reduce,
  reject,
  sort,
  sortWith,
  splitEvery,
  sum,
  uniq,
} from 'ramda'

import { getBlueprintsByTypeIDs } from '@/sdeBlueprints'
import { createClient } from '@/utils/supabase/server'

import { establishedUser } from '../account/lib/establishedUser'
import { DateTime } from '../DateTime'
import { FavoriteStar } from './favoriteStar'
import { formatIsk, formatKisk } from '../isk'
import { LinkSpinner } from '../linkSpinner'
import { Name, SystemName } from '../names'
import { fetchSystemNames } from '../systemNames'
import { fetchTypeNames } from '../typeNames'
import {
  fetchLatestSystemIndexes,
  fetchSystemIndexHistory,
  formatIndex,
  INDEX_ACTIVITY_LABELS,
  structureIndexActivities,
} from './industryIndex'
import { costAvoidance } from './costAvoidance'
import { groupByTier, jobLocationId, jobStructureIds } from './roster'
import { foldTaxLedger } from './taxLedger'
import { fetchTaxRates, formatRate } from '../settings/tax/rates'
import { foldEiv, recoveredRate, type IndexSample } from './eiv'
import { HelpTip } from './helpTip'
import { foldInstallers } from './installers'
import { formatRelativeFuture } from '../relativeTime'
import { resolveServiceIcons } from './serviceIcons'
import { StructureTabs } from './structureTabs'
import { StructureSilhouette } from './silhouette'
import { TypeIcon } from '../typeIcon'
import { Sparkline } from './sparkline'
import { WindowSelect } from './windowSelect'
import { indexBucketHours, structureWindowDays } from './windows'
import styles from './structures.module.css'

const PAGE_SIZE = 1000

// Job ids per industry_job_tax_facility() call. The function returns at most one row per id, so any
// value at or under PostgREST's max_rows keeps a batch's result whole; well under, to leave headroom
// if that cap is ever lowered.
const RPC_BATCH = 500

// Drain a PostgREST select past its max_rows (1000) cap by recursing to the
// next page until a short (or empty/errored) page signals the end — an
// unbounded pull written as tail recursion rather than a mutable loop, per the
// house style (cf. src/app/structure/revenue/page.tsx). The revenue footer sums
// every tax entry in the window, so a busy corp can exceed one page.
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

type Structure = {
  structure_id: number
  corporation_id: number | null
  // Null for a structure the directory has never resolved: we know a job of
  // ours ran there, and nothing else. Every render of these guards.
  type_id: number | null
  system_id: number | null
  name: string | null
  state: string | null
  fuel_expires: string | null
  unanchors_at: string | null
  services: Array<{ name: string; state: string }> | null
  last_seen_at: string | null
  // True when the row came from corp_structure — i.e. a director token scans
  // it, which is what makes state/services/fuel/rigs available at all. False
  // for a structure discovered from a job location and named from the public
  // directory.
  scanned: boolean
}

type JobRow = {
  job_id: number | string
  station_id: number | string | null
  facility_id: number | string | null
  // What ESI charged to install the job, when it was charged, and the shape of
  // the work — everything the EIV fold (./eiv.ts) needs to price the job's
  // material bill and split the charge. The tax measures still come from the
  // corp journal.
  cost?: number | string | null
  start_date?: string | null
  activity_id?: number | string | null
  blueprint_type_id?: number | string | null
  runs?: number | string | null
  // Who installed it, and so who was billed. corp_industry_job names the
  // corporation directly; character_industry_job names the registration, whose
  // corporation is looked up below. Absent on rows from
  // industry_job_tax_facility(), which discloses only a location.
  corporation_id?: number | string | null
  registration_id?: string | null
  // The EVE character who installed a corp job (ESI stamps corp rows only).
  installer_id?: number | string | null
}

type JournalRow = {
  amount: number | string | null
  corporation_id: number | string | null
  context_id: number | string | null
  description: string | null
  first_party_id: number | string | null
  second_party_id: number | string | null
}

// universe_name rows, and the id -> name map they turn into.
type IdName = { id: number | string; name: string }

const nameById = (rows: readonly IdName[]): Map<string, string> =>
  new Map(map((r: IdName) => [String(r.id), r.name] as [string, string], rows))

type AffiliationRow = { character_id: number | string; corporation_id: number | string }

type RigRow = {
  structure_id: number | string
  location_flag: string
  type_id: number | string
}

// universe_structure: the public directory, everything ESI hands a visitor
// about a structure they don't have a director in.
type DirectoryRow = {
  structure_id: number | string
  name: string | null
  system_id: number | string | null
  type_id: number | string | null
  owner_corporation_id: number | string | null
  resolved_at: string | null
}

type StructuresParams = {
  searchParams: Promise<{ days?: string }>
}

const StructuresPage = async ({ searchParams }: StructuresParams) => {
  const supabase = await createClient()

  const user = await establishedUser(supabase)
  if (!user) {
    redirect('/')
  }

  // The time window: the footer (per-structure Revenue, unaccounted tax, clone
  // revenue) sums only entries newer than this, and the industry-index
  // sparklines cover the same span. Driven by the ?days=N dropdown (top-right),
  // clamped to an offered option.
  const { days: daysParam } = await searchParams
  const windowDays = structureWindowDays(daysParam)
  const windowStart = new Date(Date.now() - windowDays * 86_400_000).toISOString()

  // ── The roster ────────────────────────────────────────────────────────────
  // Two sources, unioned (src/app/structure/roster.ts). corp_structure is the
  // rich one — state, services, fuel, rigs — and needs a director in the owning
  // corporation, so it covers only what we scan. Everything else we USE reaches
  // us as a bare facility id on one of our own industry jobs, named afterwards
  // from the public `universe_structure` directory.
  const { data: structures } = await supabase
    .from('corp_structure')
    .select('structure_id, corporation_id, type_id, system_id, name, state, unanchors_at, services, last_seen_at')
    .order('corporation_id', { ascending: true })
    .order('structure_id', { ascending: true })

  const scannedList = map((s: Structure): Structure => ({ ...s, scanned: true }), (structures ?? []) as Structure[])
  const scannedIds = new Set(map((s: Structure) => String(s.structure_id), scannedList))

  // Our own corporations, from our own registrations (RLS-scoped to the
  // caller). A structure any of them owns is a structure we own — including one
  // owned by a corp none of the installing characters are in, and including one
  // we can't scan because no linked character is a director there.
  const { data: ownRegistrations } = await supabase.from('registration').select('corporation_id')
  const ownCorporationIds = new Set(
    map(
      String,
      reject(
        isNil,
        map((r: { corporation_id: number | string | null }) => r.corporation_id, ownRegistrations ?? [])
      )
    )
  )

  // Every industry job of ours, both tables, drained. Two jobs at once:
  //
  //   - the job -> structure map the tax attribution below is built on, and
  //   - discovery, since a job's facility id is the only trace a structure we
  //     don't scan leaves in our data.
  //
  // Unfiltered, where this used to ask only about structures already on the
  // page — that filter was what made the page unable to see anything but its
  // own corp's structures. Drained rather than issued once: a corp with any
  // history has far more than max_rows (1000) jobs, and a single request
  // silently returns an arbitrary 1000 of them, so most jobs failed to resolve
  // and their tax fell into "unaccounted". Paging needs a total order, hence
  // order by job_id.
  const fetchJobs = (table: 'character_industry_job' | 'corp_industry_job') =>
    fetchAllRows<JobRow>((from, to) =>
      supabase
        .from(table)
        .select(
          table === 'corp_industry_job'
            ? 'job_id, station_id, facility_id, cost, start_date, activity_id, blueprint_type_id, runs, corporation_id, installer_id'
            : 'job_id, station_id, facility_id, cost, start_date, activity_id, blueprint_type_id, runs, registration_id'
        )
        .order('job_id', { ascending: true })
        .range(from, to)
        // The typed query parser gives up past a dozen columns ("Unexpected
        // input"); the shape is pinned explicitly instead.
        .returns<JobRow[]>()
    )
  const [characterJobs, corpJobs] = await Promise.all([
    fetchJobs('character_industry_job'),
    fetchJobs('corp_industry_job'),
  ])
  const allJobs = concat(characterJobs, corpJobs)

  // Structures our jobs ran in that no director of ours scans. NPC stations are
  // filtered out by the id floor, and anything already in corp_structure is
  // dropped so a structure is never listed twice.
  const externalIds = reject((id: string) => scannedIds.has(id), jobStructureIds(allJobs))

  // What ESI tells a visitor: a name, a system, a type and an owner. Asked in
  // batches, because a long `in` list is a URL a proxy is entitled to refuse —
  // and because a select is capped at max_rows like any other.
  const directoryBatches = externalIds.length
    ? await Promise.all(
        map(
          (batch: string[]) =>
            supabase
              .from('universe_structure')
              .select('structure_id, name, system_id, type_id, owner_corporation_id, resolved_at')
              .in('structure_id', batch.map(Number)),
          splitEvery(RPC_BATCH, externalIds)
        )
      )
    : []
  const directory = new Map<string, DirectoryRow>(
    map(
      (r: DirectoryRow) => [String(r.structure_id), r] as [string, DirectoryRow],
      chain(({ data }) => (data ?? []) as DirectoryRow[], directoryBatches)
    )
  )

  // A structure the directory has never resolved still gets a tile: we know a
  // job of ours ran there, which is worth saying, and the fields it can't fill
  // render as "—" rather than being invented. Sorted by name so the block reads
  // alphabetically, with the unnamed ones last.
  const externalList: Structure[] = sortWith(
    [ascend((s: Structure) => (s.name == null ? 1 : 0)), ascend((s: Structure) => s.name ?? String(s.structure_id))],
    map((id: string): Structure => {
      const row = directory.get(id)
      return {
        structure_id: Number(id),
        corporation_id: row?.owner_corporation_id != null ? Number(row.owner_corporation_id) : null,
        type_id: row?.type_id != null ? Number(row.type_id) : null,
        system_id: row?.system_id != null ? Number(row.system_id) : null,
        name: row?.name ?? null,
        state: null,
        fuel_expires: null,
        unanchors_at: null,
        services: null,
        last_seen_at: row?.resolved_at ?? null,
        scanned: false,
      }
    }, externalIds)
  )

  // Owner names for the structures we can't scan — the one thing a tile with no
  // services, rigs or fuel timer can still lead with. From the world-readable
  // corporation directory the character-directory job maintains.
  const externalOwnerIds = uniq(
    map(
      Number,
      reject(
        isNil,
        map((s: Structure) => s.corporation_id, externalList)
      )
    )
  ) as number[]
  const { data: externalOwners } = externalOwnerIds.length
    ? await supabase.from('corporation').select('corporation_id, name').in('corporation_id', externalOwnerIds)
    : { data: [] }
  const ownerNames = new Map<string, string>(
    chain(
      (c: { corporation_id: number | string; name: string | null }) =>
        c.name != null ? [[String(c.corporation_id), c.name] as [string, string]] : [],
      (externalOwners ?? []) as Array<{ corporation_id: number | string; name: string | null }>
    )
  )

  // Tier 1 of the page (docs/structure-universe/design.md): the caller's pinned
  // structures sort above everything else, in their own `position` order.
  const { data: favoriteRows } = await supabase
    .from('structure_favorite')
    .select('structure_id, position')
    .order('position', { ascending: true })
  const favoritePosition = new Map<string, number>(
    map(
      (r: { structure_id: number | string; position: number }) =>
        [String(r.structure_id), r.position] as [string, number],
      (favoriteRows ?? []) as Array<{ structure_id: number | string; position: number }>
    )
  )
  const isFavorite = (s: Structure) => favoritePosition.has(String(s.structure_id))

  const tiers = groupByTier(
    map(
      (s: Structure) => ({
        structureId: String(s.structure_id),
        ownerCorporationId: s.corporation_id != null ? String(s.corporation_id) : null,
        scanned: s.scanned,
        structure: s,
      }),
      concat(scannedList, externalList)
    ),
    { favoritePosition, ownCorporationIds }
  )
  const blocks = [
    { key: 'favorites' as const, heading: 'Favorites', structures: map((t) => t.structure, tiers.favorites) },
    { key: 'ours' as const, heading: 'Our structures', structures: map((t) => t.structure, tiers.ours) },
    {
      key: 'others' as const,
      heading: "Everyone else's structures",
      structures: map((t) => t.structure, tiers.others),
    },
  ]
  // Everything downstream — tax attribution, rigs, indexes, names — works off
  // one flat list; the blocks above only decide where each tile renders.
  const list = chain((block) => block.structures, blocks)

  // Tax revenue each structure generates. Each industry-tax journal entry references its job via
  // context_id (context_id_type = industry_job_id); outer-join those job ids to the industry-job
  // tables to find the structure (station_id, falling back to facility_id) the job is installed in,
  // then sum the journal amounts. The installer pays the tax and isn't necessarily one of this app's
  // linked characters (character_industry_job only covers those) — anyone in the corp can run a job
  // here (reactions in a refinery are often run by a dedicated alt), so corp_industry_job (pulled by
  // a director, covering every corp member) is unioned in too, mirroring /structure/revenue.
  // Otherwise a corp-run job's tax lands in "unaccounted" instead of its structure. Bigint ids can
  // come back from PostgREST as strings, so key every map by string.
  const structureIds = map((s: Structure) => Number(s.structure_id), list)
  // Keep the invariant the rest of this function depends on: every value in
  // structureByJob is a structure with a tile on this page. A job that ran in
  // an NPC station, or in a structure discovery filtered out, resolves to
  // nothing and its tax stays unaccounted rather than accruing to a row nothing
  // renders.
  const onPage = new Set(map(String, structureIds))
  const structureByJob = new Map<string, string>()
  forEach((j: JobRow) => {
    const structureId = jobLocationId(j)
    if (structureId != null && onPage.has(structureId)) structureByJob.set(String(j.job_id), structureId)
  }, allJobs)

  // The jobs that are OURS — our characters' and our corporations' alike. A job
  // of ours run in a structure of ours is billed our own rate whichever way it
  // was installed, so cost avoidance turns on this set and on who owns the
  // structure, never on which corporation the installer belonged to.
  const ownJobIds = new Set(map((j: JobRow) => String(j.job_id), allJobs))
  // The character-installed subset. This decides nothing about avoidance; it is
  // only how one charge gets billed once — a corp job's payment is the outgoing
  // entry in that corp's own wallet, while a character's has no entry to read.
  const personalJobIds = new Set(map((j: JobRow) => String(j.job_id), characterJobs))

  // The two rates behind the cost-avoidance figures live on /settings/tax.
  const taxRates = await fetchTaxRates(supabase, user.id)

  // Fuel timers live in corp_structure_status now (own-corp only). RLS returns a
  // row only for structures the caller's corp owns, so an alliance-mate's
  // structure that's visible via corp_structure simply has no fuel here.
  // Scanned ids only: both tables are own-corp data that exists precisely
  // because a director pulled it, so asking about a structure we don't scan can
  // only ever come back empty — and would pad the URL with every id discovered
  // from a job.
  const scannedStructureIds = map((s: Structure) => Number(s.structure_id), scannedList)
  const { data: statusRows } = scannedStructureIds.length
    ? await supabase
        .from('corp_structure_status')
        .select('structure_id, fuel_expires')
        .in('structure_id', scannedStructureIds)
    : { data: [] }
  const fuelByStructure = new Map<string, string | null>(
    ((statusRows ?? []) as Array<{ structure_id: number | string; fuel_expires: string | null }>).map((r) => [
      String(r.structure_id),
      r.fuel_expires,
    ])
  )
  forEach((st: Structure) => {
    st.fuel_expires = fuelByStructure.get(String(st.structure_id)) ?? null
  }, list)

  // Rigs fitted to each structure (pulled from corp assets by the corp-assets job).
  const { data: rigRows } = scannedStructureIds.length
    ? await supabase
        .from('corp_structure_rig')
        .select('structure_id, location_flag, type_id')
        .in('structure_id', scannedStructureIds)
        .order('location_flag', { ascending: true })
    : { data: [] }

  const rigList = (rigRows ?? []) as RigRow[]
  const rigTypeNames = await fetchTypeNames(map((r: RigRow) => Number(r.type_id), rigList))
  // Push-mutated per structure rather than re-spread per rig: the order the
  // select asked for is the order they render in.
  const rigsByStructure = reduce(
    (acc: Map<string, Array<{ typeID: number; name: string }>>, r: RigRow) => {
      const key = String(r.structure_id)
      const rig = { typeID: Number(r.type_id), name: rigTypeNames[Number(r.type_id)] ?? String(r.type_id) }
      const existing = acc.get(key)
      if (existing) existing.push(rig)
      else acc.set(key, [rig])
      return acc
    },
    new Map<string, Array<{ typeID: number; name: string }>>(),
    rigList
  )

  // Icons for the Services chips: ESI names services rather than modules, so
  // each known name resolves to its providing Standup module's type id through
  // the SDE (./serviceIcons.ts); an unknown name keeps a bare chip.
  const serviceIcons = await resolveServiceIcons(
    uniq(chain((st: Structure) => map((svc) => svc.name, st.services ?? []), list))
  )

  // Anchor for the relative fuel countdowns. Computed once in the server
  // render so every tile agrees and hydration has fixed text to adopt.
  const now = new Date()

  // A structure the directory hasn't resolved has no system and no type, and
  // `Number(null)` is 0 — a perfectly finite id every one of these resolvers
  // would dutifully go looking for. Drop the nulls instead.
  const ids = (pick: (s: Structure) => number | null) => uniq(map(Number, reject(isNil, map(pick, list)))) as number[]

  const systemNames = await fetchSystemNames(ids((s) => s.system_id))
  const structureTypeNames = await fetchTypeNames(ids((s) => s.type_id))

  // Latest industry cost indices for the systems we hold structures in. We only
  // show, per structure, the activities its fitted service modules enable.
  const indexesBySystem = await fetchLatestSystemIndexes(
    supabase,
    ids((s) => s.system_id)
  )
  // The same window that drives the revenue footer also scopes the index
  // sparklines. indexBucketHours widens the bucket for longer windows so the
  // point count stays sane on a 100px sparkline, and names one of the widths
  // the bucketed view materializes.
  const indexHistoryBySystem = await fetchSystemIndexHistory(
    supabase,
    ids((s) => s.system_id),
    { days: windowDays, bucketHours: indexBucketHours(windowDays) }
  )

  // Both signs, sorted out by foldTaxLedger below rather than here. industry_job_tax cuts both ways
  // in a corp wallet: a positive entry is tax someone paid to run a job in one of our structures, a
  // negative one is tax our corporation paid to run a job as ITSELF. Only the first is revenue —
  // summing both netted a corp's own industry spend against its landlord income, and a corp that
  // rents slots without owning any occupied structure showed a negative figure under a heading that
  // reads "Revenue". But the second is still an own-rate charge, and the only one a corp that runs
  // everything under corp ownership ever generates, so it feeds cost avoidance (see taxLedger.ts).
  const journal = await fetchAllRows<JournalRow>((from, to) =>
    supabase
      .from('corp_wallet_journal')
      .select('amount, corporation_id, context_id, description, first_party_id, second_party_id')
      .eq('ref_type', 'industry_job_tax')
      .gte('date', windowStart)
      .order('date', { ascending: false })
      .range(from, to)
  )

  // Both job tables above are RLS-scoped to the caller, so a job installed by another player who
  // uses this site — a renting corp's rows live under their own registration — resolves to nothing
  // here and its tax lands in "unaccounted", even though it ran in one of these structures and the
  // tax is sitting in this caller's wallet. industry_job_tax_facility (security definer) closes
  // that gap the same way /structure/revenue and structure_tax_revenue() already do: it discloses
  // only the location, and only for a job the caller can prove they were taxed for.
  //
  // Only context_ids may be asked about — never the description tokens scraped below. A loose token
  // colliding with a real job id would turn the function into an oracle for jobs the caller was
  // never taxed for (see the migration comment).
  const needsLookup = (entry: JournalRow) => entry.context_id != null && !structureByJob.has(String(entry.context_id))
  const unresolvedJobIds = uniq(map((entry: JournalRow) => String(entry.context_id), filter(needsLookup, journal)))

  //
  // Asked in batches, because a set-returning function is capped by max_rows (1000) like any other
  // select and the rows past the cap are dropped silently. The function returns at most one row per
  // job id (distinct on), so a batch of RPC_BATCH ids can never come back truncated — no paging
  // needed, and no dependence on the cap's value. Widening the window used to make revenue *fall*:
  // past ~1000 resolvable jobs the function's `order by job_id` meant the surviving rows were the
  // oldest jobs, so every recent one stopped resolving and its tax slid into "unaccounted".
  const taxedBatches = await Promise.all(
    map(
      (batch: string[]) => supabase.rpc('industry_job_tax_facility', { job_ids: batch }),
      splitEvery(RPC_BATCH, unresolvedJobIds)
    )
  )

  // The same on-page invariant the map was built under: a job taxed into our
  // wallet from somewhere not in `list` (an NPC station, a structure that has
  // dropped out of every source) stays unaccounted rather than accruing to a
  // row nothing renders — as does one ESI gave no location at all. These jobs
  // belong to other players, so they never widen the roster: discovery is
  // seeded from OUR jobs only.
  forEach(
    (j: JobRow) => {
      const structureId = jobLocationId(j)
      if (structureId != null && onPage.has(structureId)) structureByJob.set(String(j.job_id), structureId)
    },
    chain(({ data }) => (data ?? []) as JobRow[], taxedBatches)
  )

  // Who owns each structure on the page. corp_structure's RLS is own-corps OR alliance-mates, so a
  // tile here is not necessarily ours — and tax our corp paid into an ally's structure is a real
  // expense, not an expense avoided. Comparing this against the paying corporation is what tells
  // the two apart.
  // A structure the directory has never resolved has no known owner, so it maps
  // to nothing: `weOwn` reads it as not ours (correct — we can't say it is) and
  // it adds no corporation to `listedOwners`.
  const structureOwner = new Map<string, string>(
    chain(
      (st: Structure) =>
        st.corporation_id != null ? [[String(st.structure_id), String(st.corporation_id)] as [string, string]] : [],
      list
    )
  )
  // Every corporation with a tile here. Tax paid to anyone else went to a
  // landlord this page doesn't list, and is totalled separately below.
  const listedOwners = new Set<string>(structureOwner.values())

  const ledger = foldTaxLedger(
    map(
      (entry: JournalRow) => ({
        amount: Number(entry.amount ?? 0),
        corporationId: entry.corporation_id != null ? String(entry.corporation_id) : null,
        // The job id is the entry's context_id; fall back to parsing it out of the description for
        // older entries (or any ref_type variants) where ESI didn't populate context_id.
        jobIds: [
          ...(entry.context_id != null ? [String(entry.context_id)] : []),
          ...(entry.description?.match(/\d+/g) ?? []),
        ],
        payerId: entry.first_party_id != null ? String(entry.first_party_id) : null,
        recipientId: entry.second_party_id != null ? String(entry.second_party_id) : null,
      }),
      (journal ?? []) as JournalRow[]
    ),
    { structureByJob, ownJobIds, personalJobIds, ownCorporationIds, structureOwner, listedOwners }
  )

  const totalByStructure = ledger.revenueByStructure
  const taxesPaidByStructure = ledger.taxesPaidByStructure
  const taxesPaidTotal = sum([...taxesPaidByStructure.values()])
  const unaccounted = ledger.unaccounted
  const unaccountedByParty = ledger.unaccountedByParty

  const avoidance = costAvoidance(ledger.ownReceipts, taxRates)
  // Per-structure figures for the tiles. Receipts come from corp_wallet_journal,
  // whose RLS is own-corps only — so, exactly like the Revenue beside it, a
  // structure shows a figure only to callers who can read that corp's ledger.
  const avoidedByStructure = new Map(avoidance.byStructure)

  // ── EIV and the recovered facility tax ────────────────────────────────────
  // With CCP's adjusted prices mirrored (market-adjusted-prices →
  // market_adjusted_price), each manufacturing/reaction job's Estimated Item
  // Value is computable from its blueprint's ME0 bill — and at a structure we
  // don't own, subtracting the index fee and SCC surcharge from the job's
  // billed `cost` leaves the facility tax the owner charged, a number ESI
  // publishes nowhere. See src/app/structure/eiv.ts for the arithmetic and its
  // deliberate refusals.
  const systemOf = new Map<string, string>(
    chain(
      (st: Structure) =>
        st.system_id != null ? [[String(st.structure_id), String(Number(st.system_id))] as [string, string]] : [],
      list
    )
  )

  const eivJobs = filter((j: JobRow) => {
    const a = Number(j.activity_id)
    return a === 1 || a === 9
  }, allJobs)

  // ME0 bills for the blueprints those jobs run. getBlueprintsByTypeIDs
  // prefers a blueprint's manufacturing activity and falls through to its
  // reaction, which is exactly the bill each job kind consumes.
  const blueprints = await getBlueprintsByTypeIDs(
    map((j: JobRow) => Number(j.blueprint_type_id), eivJobs).filter(Number.isFinite)
  )
  const bills = Object.fromEntries(Object.entries(blueprints).map(([typeId, bp]) => [typeId, bp.materials]))

  // Adjusted prices for every material any bill names, batched under the RPC
  // cap like the other id-list fetches on this page.
  const materialIds = uniq(
    chain((bp) => map((m: { typeID: number }) => m.typeID, bp.materials), Object.values(blueprints))
  )
  const priceBatches = materialIds.length
    ? await Promise.all(
        map(
          (batch: number[]) =>
            supabase.from('market_adjusted_price').select('type_id, adjusted_price').in('type_id', batch),
          splitEvery(RPC_BATCH, materialIds)
        )
      )
    : []
  const adjustedPrices = new Map<number, number>(
    map(
      (r: { type_id: number | string; adjusted_price: number }) =>
        [Number(r.type_id), Number(r.adjusted_price)] as [number, number],
      chain(({ data }) => (data ?? []) as Array<{ type_id: number | string; adjusted_price: number }>, priceBatches)
    )
  )

  const ownStructureIds = new Set(
    filter((sid: string) => ownCorporationIds.has(structureOwner.get(sid) ?? ''), [...onPage])
  )

  // Cost-index history over the window, but only for the systems where the
  // recovery can actually run: structures our priced jobs point at that we
  // don't own. Every tile's system would be tens of thousands of hourly rows a
  // render; the rented structures are a handful (industry-systems tracks their
  // systems precisely for this, learned from our own job locations).
  const recoverySystems = uniq(
    reject(
      isNil,
      map((j: JobRow) => {
        const sid = jobLocationId(j)
        if (sid == null || !onPage.has(sid) || ownStructureIds.has(sid)) return null
        const system = systemOf.get(sid)
        return system != null ? Number(system) : null
      }, eivJobs)
    )
  ) as number[]
  const indexSystemIds = recoverySystems
  const indexRows = indexSystemIds.length
    ? await fetchAllRows<{ system_id: number | string; activity: string; cost_index: number; recorded_at: string }>(
        (from, to) =>
          supabase
            .from('industry_system_index')
            .select('system_id, activity, cost_index, recorded_at')
            .in('system_id', indexSystemIds)
            .in('activity', ['manufacturing', 'reaction'])
            .gte('recorded_at', windowStart)
            .order('recorded_at', { ascending: true })
            .range(from, to)
      )
    : []
  const indexSamples = reduce(
    (
      acc: Map<string, IndexSample[]>,
      r: { system_id: number | string; activity: string; cost_index: number; recorded_at: string }
    ) => {
      const key = `${Number(r.system_id)}:${r.activity}`
      const sample = { recordedAt: r.recorded_at, costIndex: Number(r.cost_index) }
      const existing = acc.get(key)
      if (existing) existing.push(sample)
      else acc.set(key, [sample])
      return acc
    },
    new Map<string, IndexSample[]>(),
    indexRows
  )

  const hullOf = new Map<string, number | null>(list.map((st) => [String(st.structure_id), st.type_id]))

  const eiv = foldEiv(eivJobs, {
    onPage,
    since: windowStart,
    bills,
    prices: adjustedPrices,
    indexSamples,
    systemOf,
    hullOf,
    ownStructureIds,
    journalPaidJobIds: ledger.paidJobIds,
  })
  const eivByStructure = eiv.byStructure
  const eivSkipped = eiv.skipped.noBill + eiv.skipped.noPrice + eiv.skipped.noIndex

  // ── Who ran jobs at each structure (the tile's Characters tab) ────────────
  // Our own registrations name the personal jobs; corp jobs carry the
  // installer's EVE id, resolved through the universe_name cache the
  // universe-names job keeps warm (it resolves corp job installers already).
  const { data: registrationRows } = await supabase.from('registration').select('id, name, character_id')
  const registrationsById = new Map(
    map(
      (r: { id: string; name: string; character_id: number | string | null }) =>
        [r.id, { name: r.name, characterId: r.character_id != null ? String(r.character_id) : null }] as [
          string,
          { name: string; characterId: string | null },
        ],
      (registrationRows ?? []) as Array<{ id: string; name: string; character_id: number | string | null }>
    )
  )
  const installerIds = uniq(
    reject(
      isNil,
      map((j: JobRow) => (j.installer_id != null ? Number(j.installer_id) : null), corpJobs)
    )
  ) as number[]
  const installerNameBatches = installerIds.length
    ? await Promise.all(
        map(
          (batch: number[]) => supabase.from('universe_name').select('id, name').in('id', batch),
          splitEvery(RPC_BATCH, installerIds)
        )
      )
    : []
  const installerNames = new Map<string, string>(
    map(
      (r: { id: number | string; name: string }) => [String(r.id), r.name] as [string, string],
      chain(({ data }) => (data ?? []) as Array<{ id: number | string; name: string }>, installerNameBatches)
    )
  )
  const installersByStructure = foldInstallers(allJobs, {
    onPage,
    since: windowStart,
    registrations: registrationsById,
    characterNames: installerNames,
    eivByJob: eiv.eivByJob,
  })

  // Tax that left for a landlord with no tile here. The recipient corporation
  // comes straight off the journal entry, so the total is known even when the
  // job doesn't resolve; the SYSTEM needs the job, which was never fetched above
  // (that select is filtered to structures on the page), so the handful of job
  // ids involved are looked up directly. Only corp jobs can appear here — a
  // character's personal job pays from a wallet we have no journal for.
  const unlistedJobIds = uniq(
    ledger.unlistedPayments.map((p) => p.jobId).filter((id): id is string => id != null && !structureByJob.has(id))
  )
  const unlistedJobStructure = new Map<string, string>()
  if (unlistedJobIds.length > 0) {
    const batches = await Promise.all(
      map(
        (batch: string[]) =>
          supabase.from('corp_industry_job').select('job_id, station_id, facility_id').in('job_id', batch.map(Number)),
        splitEvery(RPC_BATCH, unlistedJobIds)
      )
    )
    forEach(
      (j: JobRow) => {
        const structureId = j.station_id ?? j.facility_id
        if (structureId != null) unlistedJobStructure.set(String(j.job_id), String(structureId))
      },
      chain(({ data }) => (data ?? []) as JobRow[], batches)
    )
  }

  // Those structures' systems, from the universe_structure cache the
  // universe-structures job maintains. A structure we've never been able to
  // resolve simply contributes no system rather than blocking the ISK figure.
  const unlistedSystemByStructure = new Map<string, string>()
  const unlistedStructureIds = uniq([...unlistedJobStructure.values()])
  if (unlistedStructureIds.length > 0) {
    const { data: known } = await supabase
      .from('universe_structure')
      .select('structure_id, system_id')
      .in('structure_id', unlistedStructureIds.map(Number))
    forEach(
      (r: { structure_id: number | string; system_id: number | string | null }) => {
        if (r.system_id != null) unlistedSystemByStructure.set(String(r.structure_id), String(r.system_id))
      },
      (known ?? []) as Array<{ structure_id: number | string; system_id: number | string | null }>
    )
  }

  // One row per landlord: what they took, and where. Largest first.
  const unlistedByCorp = new Map<string, { amount: number; systemIds: Set<string> }>()
  forEach((payment: (typeof ledger.unlistedPayments)[number]) => {
    const key = payment.corporationId ?? 'unknown'
    const row = unlistedByCorp.get(key) ?? { amount: 0, systemIds: new Set<string>() }
    row.amount += payment.amount
    const structureId = payment.jobId != null ? unlistedJobStructure.get(payment.jobId) : undefined
    const systemId = structureId != null ? unlistedSystemByStructure.get(structureId) : undefined
    if (systemId != null) row.systemIds.add(systemId)
    unlistedByCorp.set(key, row)
  }, ledger.unlistedPayments)
  const unlistedLandlords = sortWith(
    [descend(([, row]: [string, { amount: number }]) => row.amount)],
    [...unlistedByCorp.entries()]
  )
  const unlistedTotal = sum(map(([, row]) => row.amount, unlistedLandlords))

  // Landlord names from the world-readable corporation directory, and system
  // names alongside the ones the tiles already resolve.
  const landlordNames = new Map<string, string>()
  const landlordIds = unlistedLandlords.map(([id]) => id).filter((id) => id !== 'unknown')
  if (landlordIds.length > 0) {
    const { data: corps } = await supabase
      .from('corporation')
      .select('corporation_id, name')
      .in('corporation_id', landlordIds.map(Number))
    forEach(
      (c: { corporation_id: number | string; name: string | null }) => {
        if (c.name != null) landlordNames.set(String(c.corporation_id), c.name)
      },
      (corps ?? []) as Array<{ corporation_id: number | string; name: string | null }>
    )
  }
  const unlistedSystemNames = await fetchSystemNames(
    uniq(unlistedLandlords.flatMap(([, row]) => [...row.systemIds])).map(Number)
  )

  // Largest payers first.
  const unaccountedParties = sortWith([descend(([, isk]: [string, number]) => isk)], [...unaccountedByParty.entries()])

  // Resolve each payer (a character) to their name and the corp they fly for. Names come from the
  // universe_name table (populated by the universe-names job) and corp affiliations from
  // character_affiliation (populated by the character-directory job); ids not yet resolved fall
  // back to showing the raw id.
  const partyIds = map(
    Number,
    reject(
      (p: string) => p === 'unknown',
      map(([party]: [string, number]) => party, unaccountedParties)
    )
  )

  const { data: charNames } = partyIds.length
    ? await supabase.from('universe_name').select('id, name').in('id', partyIds)
    : { data: [] }
  const payerNames = nameById((charNames ?? []) as IdName[])

  const { data: affiliations } = partyIds.length
    ? await supabase.from('character_affiliation').select('character_id, corporation_id').in('character_id', partyIds)
    : { data: [] }
  const affiliationRows = (affiliations ?? []) as AffiliationRow[]
  const corpByParty = map(
    (a: AffiliationRow) => [String(a.character_id), String(a.corporation_id)] as [string, string],
    affiliationRows
  )
  const corpIds = uniq(map((a: AffiliationRow) => Number(a.corporation_id), affiliationRows))

  const { data: corpNames } = corpIds.length
    ? await supabase.from('universe_name').select('id, name').in('id', corpIds)
    : { data: [] }
  const corpNameById = nameById((corpNames ?? []) as IdName[])

  // A party whose corporation the directory hasn't named yet simply has no corp
  // line, rather than one reading as an id.
  const payerCorps = new Map<string, string>(
    chain(([party, corpId]: [string, string]) => {
      const name = corpNameById.get(corpId)
      return name ? [[party, name] as [string, string]] : []
    }, corpByParty)
  )

  // Revenue from structure clone bays (jump clone installation and activation
  // fees), over the same window as the tax revenue above.
  const cloneJournal = await fetchAllRows<{ amount: number | string | null }>((from, to) =>
    supabase
      .from('corp_wallet_journal')
      .select('amount')
      .in('ref_type', ['jump_clone_installation_fee', 'jump_clone_activation_fee'])
      .gte('date', windowStart)
      .order('date', { ascending: false })
      .range(from, to)
  )

  const cloneRevenue = sum(map((entry: { amount: number | string | null }) => Number(entry.amount ?? 0), cloneJournal))

  // When the Structures background job last finished. Each scheduled run writes a
  // public.heartbeat row stamped with ended_at and a link to the workflow run; we
  // read back the most recent completed one.
  const { data: lastRun } = await supabase
    .from('heartbeat')
    .select('ended_at, run_url')
    .eq('job', 'corp-structures')
    .not('ended_at', 'is', null)
    .order('ended_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  return (
    <>
      <div className={styles.header}>
        <h1>Structures</h1>
        <span className={styles.headerControl}>
          <span className={styles.headerControlLabel}>Window</span>
          <WindowSelect days={windowDays} />
        </span>
      </div>
      <p className={styles.pageLinks}>
        <Link href="/structure/revenue">Tax revenue events &raquo;</Link>
        <Link href="/mercenary-dens">Mercenary dens &raquo;</Link>
      </p>
      {list.length > 0 ? (
        <>
          {blocks.map((block) =>
            block.structures.length === 0 ? null : (
              <section key={block.key}>
                <h2 className={styles.blockHeading}>{block.heading}</h2>
                {block.key === 'others' && (
                  <p className={styles.blockNote}>
                    <em>
                      Structures our jobs run in that no director of ours can scan, so only what ESI tells a visitor is
                      known: no fitting, no services, no fuel timer.
                    </em>
                  </p>
                )}
                <ul className={styles.grid}>
                  {block.structures.map((s) => {
                    const rigs = rigsByStructure.get(String(s.structure_id)) ?? []
                    const services = s.services?.map((svc) => svc.name) ?? []
                    const indexActivities = structureIndexActivities(s.services)
                    const systemIndexes = indexesBySystem.get(Number(s.system_id))
                    const systemHistory = indexHistoryBySystem.get(Number(s.system_id))
                    // The render backs the title rather than sitting above it, so the
                    // head carries the over-image treatment only when there is an image
                    // to sit on — the silhouette fallback keeps the plain tile colours.
                    const head = (
                      <div className={s.type_id != null ? `${styles.head} ${styles.heroHead}` : styles.head}>
                        <div>
                          <Link href={`/structure/${s.structure_id}`} className={styles.name}>
                            {s.name ?? `Structure #${s.structure_id}`}
                            <LinkSpinner />
                          </Link>
                          {/* Upwell structures share their structure_id with the station/facility id industry jobs run at. */}
                          <span className={styles.subId}>#{s.structure_id}</span>
                        </div>
                        <FavoriteStar structureId={String(s.structure_id)} favorite={isFavorite(s)} />
                      </div>
                    )
                    return (
                      <li key={`structure-${s.structure_id}`} className={styles.tile}>
                        {s.type_id != null ? (
                          <div className={styles.hero}>
                            <TypeIcon id={s.type_id} size={256} prefer="render" className={styles.heroArt} />
                            {head}
                          </div>
                        ) : (
                          <>
                            <StructureSilhouette typeId={0} className={styles.silhouette} />
                            {head}
                          </>
                        )}

                        <div className={styles.fields}>
                          {(() => {
                            const key = String(s.structure_id)
                            const row = eivByStructure.get(key)
                            const journalPaid = taxesPaidByStructure.get(key)
                            const revenue = totalByStructure.get(key)
                            const hasMeasures =
                              (row != null && (row.eiv > 0 || row.recoveredJobs > 0)) ||
                              journalPaid != null ||
                              revenue != null ||
                              avoidedByStructure.has(key)
                            // A journal receipt is exact and wins; the recovered
                            // estimate stands in where no journal can see the
                            // charge. Either way the rate is the tax against
                            // this structure's EIV over the same window — and 0
                            // is shown, not hidden: it means the owner charges
                            // nothing, while the index fee and SCC surcharge in
                            // the job cost went to CCP, not to them.
                            const rate = row != null ? recoveredRate(row) : null
                            return (
                              <>
                                {hasMeasures && (
                                  <HelpTip
                                    text={[
                                      "Industry EIV — the Estimated Item Value of the manufacturing and reaction jobs installed here in the window: the total industrial impact on the system's cost index. The index fee, the owner's facility tax, and the 4% SCC surcharge are all charged as fractions of it — think of it as this structure's market share of the system's industry.",
                                      "Taxes Paid — facility tax paid to this structure's owner: exact from the corp wallet journal where we can read it, estimated from job costs elsewhere (cost minus index fee minus 4% SCC surcharge). The subtracted fees are ~14× the typical tax, so the estimate resolves whole fractions of a percent at best: ≈0% means at or below what it can distinguish from free, not that the owner provably charges nothing.",
                                      'Revenue — industry tax received into our corp wallets from jobs run in this structure.',
                                      'Cost Avoidance — facility tax never incurred because our own jobs ran at our own rate instead of a public one.',
                                    ].join('\n\n')}
                                  />
                                )}
                                {row != null && row.eiv > 0 && (
                                  <>
                                    <span className={styles.label}>Industry EIV</span>
                                    <span className={`${styles.value} ${styles.num}`}>{formatIsk(row.eiv)}</span>
                                  </>
                                )}
                                {journalPaid != null && (
                                  <>
                                    <span className={styles.label}>Taxes Paid</span>
                                    <span className={`${styles.value} ${styles.num}`}>
                                      {formatIsk(journalPaid)}
                                      {row != null && row.eiv > 0 && (
                                        <span className={styles.hoverPct}>
                                          ≈{formatRate(journalPaid / row.eiv)} of EIV
                                        </span>
                                      )}
                                    </span>
                                  </>
                                )}
                                {/* Not an else: the ledger's paidJobIds keeps recovery off every
                                    journal-billed job, so the two figures are disjoint shares of
                                    the same structure — corp-installed jobs land in the exact row
                                    above, personal jobs at a rented structure only in this one.
                                    A mixed structure legitimately shows both. */}
                                {row != null && row.recoveredJobs > 0 && (
                                  <>
                                    <span className={styles.label}>Taxes Paid (est.)</span>
                                    <span className={`${styles.value} ${styles.num}`}>
                                      {formatIsk(row.recoveredTax)}
                                      {rate != null && (
                                        <span className={styles.hoverPct}>≈{formatRate(rate)} of EIV</span>
                                      )}
                                    </span>
                                  </>
                                )}
                                {revenue != null && (
                                  <>
                                    <span className={styles.label}>Revenue</span>
                                    <span className={`${styles.value} ${styles.num}`}>{formatIsk(revenue)}</span>
                                  </>
                                )}
                                {avoidedByStructure.has(key) && (
                                  <>
                                    <span className={styles.label}>Cost Avoidance</span>
                                    <span className={`${styles.value} ${styles.num}`}>
                                      {formatIsk(avoidedByStructure.get(key) ?? 0)}
                                    </span>
                                  </>
                                )}
                              </>
                            )
                          })()}
                          <span className={styles.label}>Type</span>
                          <span className={styles.value}>
                            <Name
                              name={s.type_id != null ? structureTypeNames[Number(s.type_id)] : undefined}
                              id={s.type_id}
                            />
                          </span>
                          <span className={styles.label}>System</span>
                          <span className={styles.value}>
                            <SystemName
                              name={s.system_id != null ? systemNames[Number(s.system_id)] : undefined}
                              id={s.system_id}
                            />
                          </span>
                          {!s.scanned && (
                            <>
                              <span className={styles.label}>Owner</span>
                              <span className={styles.value}>
                                <Name
                                  name={s.corporation_id != null ? ownerNames.get(String(s.corporation_id)) : undefined}
                                  id={s.corporation_id}
                                />
                              </span>
                            </>
                          )}
                          {s.fuel_expires && (
                            <>
                              <span className={styles.label}>Fuel Expires</span>
                              <span className={styles.value}>
                                <DateTime value={s.fuel_expires} />
                                {(() => {
                                  const relative = formatRelativeFuture(s.fuel_expires, now)
                                  return relative ? <span className={styles.subLine}>{relative}</span> : null
                                })()}
                              </span>
                            </>
                          )}
                        </div>

                        <StructureTabs
                          services={services.map((svc) => ({ name: svc, typeID: serviceIcons.get(svc) ?? null }))}
                          rigs={rigs.map((rig) => ({ name: rig.name, typeID: rig.typeID }))}
                          characters={installersByStructure.get(String(s.structure_id)) ?? []}
                        />

                        {indexActivities.length > 0 && (
                          <div className={styles.section}>
                            <span className={styles.sectionLabel}>Industry Indexes</span>
                            <ul className={styles.indexes}>
                              {indexActivities.map((activity) => {
                                const cost = systemIndexes?.get(activity)
                                const series = systemHistory?.get(activity)
                                const values = series?.values ?? []
                                return (
                                  <li key={`idx-${s.structure_id}-${activity}`} className={styles.indexRow}>
                                    <span className={styles.indexLabel}>{INDEX_ACTIVITY_LABELS[activity]}</span>
                                    <Sparkline
                                      values={values}
                                      liveCount={series?.liveCount}
                                      updatedAt={series?.updatedAt}
                                      label={INDEX_ACTIVITY_LABELS[activity]}
                                    />
                                    <span className={styles.indexValue}>{cost != null ? formatIndex(cost) : '—'}</span>
                                  </li>
                                )
                              })}
                            </ul>
                          </div>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </section>
            )
          )}

          <div className={styles.footer}>
            {unaccountedParties.length > 0 && (
              <>
                <span>Unaccounted tax revenue:</span>
                <span className={styles.footerValue}>{formatIsk(unaccounted)}</span>
              </>
            )}
            {taxesPaidTotal > 0 && (
              <>
                <span>Taxes paid:</span>
                <span className={styles.footerValue}>{formatIsk(taxesPaidTotal)}</span>
              </>
            )}
            {unlistedTotal > 0 && (
              <>
                <span>Taxes paid elsewhere:</span>
                <span className={styles.footerValue}>{formatIsk(unlistedTotal)}</span>
              </>
            )}
            {eiv.totalRecoveredTax > 0 && (
              <>
                <span>Taxes paid (est.):</span>
                <span className={styles.footerValue}>{formatIsk(eiv.totalRecoveredTax)}</span>
              </>
            )}
            {eiv.totalEiv > 0 && (
              <>
                <span>Total EIV:</span>
                <span className={styles.footerValue}>{formatIsk(eiv.totalEiv)}</span>
              </>
            )}
            <span>Clone revenue:</span>
            <span className={styles.footerValue}>{formatKisk(cloneRevenue)}</span>
            <span>Cost avoidance:</span>
            <span className={styles.footerValue}>{avoidance.total == null ? '—' : formatIsk(avoidance.total)}</span>
          </div>
          <p className={styles.unaccountedNote}>
            <em>
              {avoidance.total == null ? (
                <>
                  Cost avoidance needs a non-zero rate for your own characters — nothing was billed, so there is no
                  receipt to price a public structure against.{' '}
                </>
              ) : (
                <>
                  Cost avoidance is facility tax never incurred: {avoidance.jobs.toLocaleString()} job
                  {avoidance.jobs === 1 ? '' : 's'} of ours ran in our own structures and paid us{' '}
                  {formatIsk(avoidance.billed)} at {formatRate(taxRates.own)}, where a public{' '}
                  {formatRate(taxRates.public)} would have cost {formatIsk(avoidance.counterfactual ?? 0)} and kept it.
                  No ISK changed hands, so it is not revenue.{' '}
                </>
              )}
              <Link href="/settings/tax">Change the rates &raquo;</Link>
            </em>
          </p>
          {taxesPaidTotal > 0 && (
            <p className={styles.unaccountedNote}>
              <em>
                Taxes paid is facility tax we were actually charged, for jobs run in the structures listed above —
                including the {formatRate(taxRates.own)} our own structures bill us. Tax paid to a corporation with no
                structure here is counted separately, since it has no tile to belong to. Neither figure can see what a
                character paid to a corporation that isn&rsquo;t ours: that leaves a wallet we have no journal for.
              </em>
            </p>
          )}
          {eiv.totalEiv > 0 && (
            <p className={styles.unaccountedNote}>
              <em>
                Total EIV is the Estimated Item Value of our manufacturing and reaction jobs installed at these
                structures over the window &mdash; each job&rsquo;s ME0 material bill priced at CCP&rsquo;s adjusted
                prices, the base the game levies every install fee against. Estimated taxes recover the facility tax at
                structures we don&rsquo;t own, where the charge leaves a wallet no journal of ours covers: a job&rsquo;s
                billed cost minus its system-index fee (at the index when it was installed) and the 4% SCC surcharge
                leaves the owner&rsquo;s cut, and dividing by EIV gives their rate. The estimate assumes Omega
                installers and current adjusted prices
                {eivSkipped > 0 && (
                  <>
                    ; {eivSkipped.toLocaleString()} job{eivSkipped === 1 ? '' : 's'} could not be priced (missing bill,
                    price, or index history) and count{eivSkipped === 1 ? 's' : ''} toward nothing
                  </>
                )}
                .
              </em>
            </p>
          )}
          {unaccountedParties.length > 0 && (
            <p className={styles.unaccountedNote}>
              <em>
                Unaccounted revenue comes from industry jobs started by players we can&rsquo;t see, so we can&rsquo;t
                tie the tax back to one of our structures.
              </em>
            </p>
          )}
          {unlistedLandlords.length > 0 && (
            <details className={styles.breakdown}>
              <summary>Taxes paid elsewhere, by corporation ({unlistedLandlords.length})</summary>
              <div className={styles.breakdownGrid}>
                {unlistedLandlords.map(([corporationId, row]) => {
                  const name =
                    corporationId === 'unknown'
                      ? 'Unknown corporation'
                      : (landlordNames.get(corporationId) ?? `#${corporationId}`)
                  // Systems we could place the jobs in. A structure the cache
                  // has never resolved contributes none, so the ISK still shows
                  // with no system rather than being hidden.
                  const systems = sort(
                    (a: string, b: string) => a.localeCompare(b),
                    map((id: string) => unlistedSystemNames[Number(id)] ?? `#${id}`, [...row.systemIds])
                  )
                  return (
                    <span key={`landlord-${corporationId}`} className={styles.breakdownRow}>
                      <span className={styles.payer}>
                        <span>{name}</span>
                        {systems.length > 0 && <span className={styles.payerCorp}>{systems.join(', ')}</span>}
                      </span>
                      <span className={styles.footerValue}>{formatIsk(row.amount)}</span>
                    </span>
                  )
                })}
              </div>
            </details>
          )}
          {unaccountedParties.length > 0 && (
            <details className={styles.breakdown}>
              <summary>Breakdown by payer ({unaccountedParties.length})</summary>
              <div className={styles.breakdownGrid}>
                {unaccountedParties.map(([party, amount]) => {
                  const name = party === 'unknown' ? 'Unknown' : (payerNames.get(party) ?? party)
                  const corp = party === 'unknown' ? undefined : payerCorps.get(party)
                  return (
                    <span key={`party-${party}`} className={styles.breakdownRow}>
                      <span className={styles.payer}>
                        <span>{name}</span>
                        {corp && <span className={styles.payerCorp}>{corp}</span>}
                      </span>
                      <span className={styles.footerValue}>{formatIsk(amount)}</span>
                    </span>
                  )
                })}
              </div>
            </details>
          )}
        </>
      ) : (
        <p>
          No structures visible. Re-link a director character on the{' '}
          <Link href="/account/registrations">Registrations</Link> page so the hourly job can fetch them.
        </p>
      )}
      <p className={styles.lastRun}>
        Structures last refreshed:{' '}
        {lastRun?.run_url ? (
          <a href={lastRun.run_url}>
            <DateTime value={lastRun.ended_at} fallback="never" />
          </a>
        ) : (
          <DateTime value={lastRun?.ended_at} fallback="never" />
        )}
      </p>
    </>
  )
}
export default StructuresPage
