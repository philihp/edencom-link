// The per-structure measures a /structure tile shows — Industry EIV, Taxes
// Paid (exact and estimated), Revenue, Cost Avoidance and the Characters tab —
// computed once, here, for whichever structures the caller lists. The index
// passes every tile; /structure/[structureId] passes its one structure, so the
// detail page can never show less than the tile that links to it: both are the
// same fold over the same rows. Every figure is per structure — a job, a tax
// entry or an EIV row only ever lands on the structure it ran in — so asking
// about one structure answers exactly what the index answers for it.
import { chain, concat, filter, forEach, isNil, map, reduce, reject, splitEvery, uniq } from 'ramda'

import { getBlueprintsByTypeIDs } from '@/sdeBlueprints'
import type { createClient } from '@/utils/supabase/server'

import type { TaxRates } from '../settings/tax/rates'
import { costAvoidance } from './costAvoidance'
import { foldEiv, type IndexSample } from './eiv'
import { foldInstallers } from './installers'
import { journalCoveredStructures } from './journalCoverage'
import { jobLocationId } from './roster'
import { foldTaxLedger } from './taxLedger'

type Supabase = Awaited<ReturnType<typeof createClient>>

const PAGE_SIZE = 1000

// Job ids per industry_job_tax_facility() call. The function returns at most one row per id, so any
// value at or under PostgREST's max_rows keeps a batch's result whole; well under, to leave headroom
// if that cap is ever lowered.
export const RPC_BATCH = 500

// Drain a PostgREST select past its max_rows (1000) cap by recursing to the
// next page until a short (or empty/errored) page signals the end — an
// unbounded pull written as tail recursion rather than a mutable loop, per the
// house style (cf. src/app/structure/revenue/page.tsx). The revenue footer sums
// every tax entry in the window, so a busy corp can exceed one page.
export const fetchAllRows = async <T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  from = 0,
  acc: readonly T[] = []
): Promise<T[]> => {
  const { data, error } = await build(from, from + PAGE_SIZE - 1)
  if (error || !data || data.length === 0) return [...acc]
  const rows = concat(acc, data)
  return data.length < PAGE_SIZE ? rows : fetchAllRows(build, from + PAGE_SIZE, rows)
}

// What the measures need to know about a structure: where it is, what hull it
// is, and who owns it.
export type MeasuredStructure = {
  structure_id: number
  corporation_id: number | null
  type_id: number | null
  system_id: number | null
}
type Structure = MeasuredStructure

export type JobRow = {
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

// Every industry job we can see, both tables, drained: ours, plus the
// current jobs of everyone else building at a structure we hold an open job
// in (the tenant policies — docs/sharing-layer/13-industry-job-share.md).
// Three jobs at once:
//
//   - the job -> structure map the tax attribution below is built on,
//   - discovery, since a job's facility id is the only trace a structure we
//     don't scan leaves in our data (a co-tenant's job can only ever name a
//     structure one of ours already does), and
//   - the Characters tab, which is the whole point of seeing the others.
//
// Seeing a job is no longer owning it: anything that means "ours" below
// tests the row's registration or corporation against our own, never its
// presence in this list.
//
// Unfiltered, where this used to ask only about structures already on the
// page — that filter was what made the page unable to see anything but its
// own corp's structures. Drained rather than issued once: a corp with any
// history has far more than max_rows (1000) jobs, and a single request
// silently returns an arbitrary 1000 of them, so most jobs failed to resolve
// and their tax fell into "unaccounted". Paging needs a total order, hence
// order by job_id.
//
// "Unfiltered" is the index's call. `structureId` narrows both tables to jobs at one structure, for the detail
// page: the measures only ever count a job toward the structure it ran in, so
// the rest are dead weight there.
export const fetchIndustryJobs = async (supabase: Supabase, structureId?: string) => {
  const fetchJobs = (table: 'character_industry_job' | 'corp_industry_job') =>
    fetchAllRows<JobRow>((from, to) => {
      const query = supabase
        .from(table)
        .select(
          table === 'corp_industry_job'
            ? 'job_id, station_id, facility_id, cost, start_date, activity_id, blueprint_type_id, runs, corporation_id, installer_id'
            : 'job_id, station_id, facility_id, cost, start_date, activity_id, blueprint_type_id, runs, registration_id'
        )
      // Digits only: the caller validated the id before it reaches the filter.
      const scoped =
        structureId != null ? query.or(`station_id.eq.${structureId},facility_id.eq.${structureId}`) : query
      return (
        scoped
          .order('job_id', { ascending: true })
          .range(from, to)
          // The typed query parser gives up past a dozen columns ("Unexpected
          // input"); the shape is pinned explicitly instead.
          .returns<JobRow[]>()
      )
    })
  const [characterJobs, corpJobs] = await Promise.all([
    fetchJobs('character_industry_job'),
    fetchJobs('corp_industry_job'),
  ])
  return { characterJobs, corpJobs }
}

export type StructureMeasuresInput = {
  list: readonly MeasuredStructure[]
  characterJobs: readonly JobRow[]
  corpJobs: readonly JobRow[]
  ownRegistrationIds: ReadonlySet<string>
  ownCorporationIds: ReadonlySet<string>
  windowStart: string
  taxRates: TaxRates
}

export const loadStructureMeasures = async (supabase: Supabase, input: StructureMeasuresInput) => {
  const { list, characterJobs, corpJobs, ownRegistrationIds, ownCorporationIds, windowStart, taxRates } = input
  const allJobs = concat(characterJobs, corpJobs)

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
  // structure, never on which corporation the installer belonged to. Tested on
  // the row: a co-tenant's job is in allJobs too, and read as ours it would
  // file its tax receipt as an own-rate charge instead of revenue.
  const isOwnJob = (j: JobRow) =>
    (j.registration_id != null && ownRegistrationIds.has(String(j.registration_id))) ||
    (j.corporation_id != null && ownCorporationIds.has(String(j.corporation_id)))
  const ownCharacterJobs = filter(isOwnJob, characterJobs)
  const ownJobIds = new Set(map((j: JobRow) => String(j.job_id), filter(isOwnJob, allJobs)))
  // The character-installed subset. This decides nothing about avoidance; it is
  // only how one charge gets billed once — a corp job's payment is the outgoing
  // entry in that corp's own wallet, while a character's has no entry to read.
  const personalJobIds = new Set(map((j: JobRow) => String(j.job_id), ownCharacterJobs))

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

  // Who owns each structure on the page. corp_structure's RLS is own-corps OR a share's audience, so a
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

  const avoidance = costAvoidance(ledger.ownReceipts, taxRates)

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

  // Which of our corporations we can actually read a wallet journal for.
  //
  // Recovery is suppressed where the journal already bills the charge exactly,
  // and that used to be decided by *ownership*: a structure owned by any corp
  // this account has a character in counted as covered. Those are different
  // facts, and they come apart on a shared corp where no token of ours holds
  // the accountant/director roles. There the journal is not merely inexact,
  // it is empty — corp-wallet-journal fails every run — so suppressing recovery
  // hid the facility tax entirely: neither the exact row nor the estimate had
  // anything to show, on structures this account pays real ISK to use.
  //
  // Asked as one cheap existence probe per candidate corporation rather than a
  // distinct over the journal: PostgREST has no DISTINCT, the table runs to
  // six figures of rows for an active corp, and the candidate set is the
  // handful of our corporations that own a tile here. `limit(1)` makes each an
  // index probe. Deliberately not scoped to the page's window or to
  // ref_type=industry_job_tax — the question is whether the journal is being
  // ingested at all, and a corp with no industry tax this month still has an
  // exact record of that fact.
  const candidateCoveredCorps = uniq(
    filter((corp: string) => ownCorporationIds.has(corp), [...structureOwner.values()])
  )
  const coverageProbes = candidateCoveredCorps.length
    ? await Promise.all(
        map(async (corp: string) => {
          const { data } = await supabase
            .from('corp_wallet_journal')
            .select('corporation_id')
            .eq('corporation_id', Number(corp))
            .limit(1)
          return (data ?? []).length > 0 ? corp : null
        }, candidateCoveredCorps)
      )
    : []
  const journalCoveredCorps = new Set(reject(isNil, coverageProbes) as string[])

  const journalCoveredStructureIds = journalCoveredStructures({ onPage, structureOwner, journalCoveredCorps })

  // Cost-index history over the window, but only for the systems where the
  // recovery can actually run: structures our priced jobs point at whose tax no
  // journal of ours bills. Every tile's system would be tens of thousands of
  // hourly rows a render; those structures are a handful (industry-systems
  // tracks their systems precisely for this, learned from our own job
  // locations).
  const recoverySystems = uniq(
    reject(
      isNil,
      map((j: JobRow) => {
        const sid = jobLocationId(j)
        if (sid == null || !onPage.has(sid) || journalCoveredStructureIds.has(sid)) return null
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
    journalCoveredStructureIds,
    journalPaidJobIds: ledger.paidJobIds,
  })
  const eivSkipped = eiv.skipped.noBill + eiv.skipped.noPrice + eiv.skipped.noIndex

  // ── Who ran jobs at each structure (the tile's Characters tab) ────────────
  // Personal jobs name a registration, and each is its own row: an account can
  // hold several people's characters, and nothing in the registration tells
  // them apart. Our own registrations come from `registration`; a co-tenant's
  // (RLS hides theirs) resolves through the world-readable character directory,
  // which maps a registration uuid to its character and name and nothing more.
  // Corp jobs name the corporation they were run for, which is the only honest
  // unit for them. See ./installers.ts.
  type RegistrationRow = { id: string; name: string; character_id: number | string | null }
  const { data: registrationRows } = await supabase
    .from('registration')
    .select('id, name, character_id')
    .returns<RegistrationRow[]>()
  const registrationsById = new Map(
    map(
      (r: RegistrationRow) =>
        [r.id, { name: r.name, characterId: r.character_id != null ? String(r.character_id) : null }] as [
          string,
          { name: string; characterId: string | null },
        ],
      registrationRows ?? []
    )
  )
  type DirectoryEntry = { registration_id: string; name: string; character_id: number | string }
  const foreignRegistrationIds = uniq(
    reject(
      isNil,
      map(
        (j: JobRow) =>
          j.registration_id != null && !registrationsById.has(String(j.registration_id))
            ? String(j.registration_id)
            : null,
        characterJobs
      )
    )
  ) as string[]
  const directoryEntryBatches = foreignRegistrationIds.length
    ? await Promise.all(
        map(
          (batch: string[]) =>
            supabase
              .from('character_directory')
              .select('registration_id, name, character_id')
              .in('registration_id', batch)
              .returns<DirectoryEntry[]>(),
          splitEvery(RPC_BATCH, foreignRegistrationIds)
        )
      )
    : []
  forEach(
    (entry: DirectoryEntry) => {
      registrationsById.set(entry.registration_id, { name: entry.name, characterId: String(entry.character_id) })
    },
    chain(({ data }) => data ?? [], directoryEntryBatches)
  )
  // Corp-job rows group by their corporation, so they need its name. The
  // `corporation` directory is what the external-owner lookup above already
  // reads; a corporation missing from it falls back to a labelled id.
  const jobCorporationIds = uniq(
    reject(
      isNil,
      map((j: JobRow) => (j.corporation_id != null ? Number(j.corporation_id) : null), corpJobs)
    )
  ) as number[]
  const corporationNameBatches = jobCorporationIds.length
    ? await Promise.all(
        map(
          (batch: number[]) => supabase.from('corporation').select('corporation_id, name').in('corporation_id', batch),
          splitEvery(RPC_BATCH, jobCorporationIds)
        )
      )
    : []
  const jobCorporationNames = new Map<string, string>(
    chain(
      (r: { corporation_id: number | string; name: string | null }) =>
        r.name != null ? [[String(r.corporation_id), r.name] as [string, string]] : [],
      chain(
        ({ data }) => (data ?? []) as Array<{ corporation_id: number | string; name: string | null }>,
        corporationNameBatches
      )
    )
  )
  const installersByStructure = foldInstallers(allJobs, {
    onPage,
    since: windowStart,
    registrations: registrationsById,
    corporationNames: jobCorporationNames,
    eivByJob: eiv.eivByJob,
  })

  return {
    structureByJob,
    ledger,
    avoidance,
    eiv,
    eivSkipped,
    installersByStructure,
  }
}

export type StructureMeasures = Awaited<ReturnType<typeof loadStructureMeasures>>
