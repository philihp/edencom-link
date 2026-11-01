// The per-structure measures a /structure tile shows — Your Total EIV, Taxes
// Paid (exact and estimated), Revenue, Cost Avoidance and the Characters tab —
// read from the per-day rollup (docs/structure-measure-rollup.md) for
// whichever structures the caller lists. The index passes every tile;
// /structure/[structureId] passes its one structure, so the detail page can
// never show less than the tile that links to it: both sum the same rows.
//
// Two selects, one per rollup table, each one indexed range per owner over
// the window's days — no job view is drained and no journal is read. The
// rows are per OWNER (a registration or a corporation; structure_measure_day
// explains why), so the account's figure is the sum over its own owners,
// and what the rollup could not decide per owner is decided here
// (./measureWindow.ts): whether a charge was billed at our own rate, and
// whether an estimate stands.
import { chain, isNil, map, reject, splitEvery, uniq } from 'ramda'

import type { createClient } from '@/utils/supabase/server'

import type { TaxRates } from '../settings/tax/rates'
import { costAvoidance } from './costAvoidance'
import { journalCoveredStructures } from './journalCoverage'
import { foldInstallerWindow, foldMeasureWindow, type InstallerWindowRow, type MeasureWindowRow } from './measureWindow'

type Supabase = Awaited<ReturnType<typeof createClient>>

const PAGE_SIZE = 1000

// Ids per `in` filter: a long list is a URL a proxy is entitled to refuse, and
// a select is capped at max_rows like any other.
export const RPC_BATCH = 500

// Drain a PostgREST select past its max_rows (1000) cap by recursing to the
// next page until a short (or empty/errored) page signals the end — an
// unbounded pull written as tail recursion rather than a mutable loop, per the
// house style (cf. src/app/structure/revenue/page.tsx).
export const fetchAllRows = async <T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  from = 0,
  acc: readonly T[] = []
): Promise<T[]> => {
  const { data, error } = await build(from, from + PAGE_SIZE - 1)
  if (error || !data || data.length === 0) return [...acc]
  const rows = [...acc, ...data]
  return data.length < PAGE_SIZE ? rows : fetchAllRows(build, from + PAGE_SIZE, rows)
}

// What the measures need to know about a structure: who owns it. (Its system
// and hull mattered when the page priced jobs itself; the rollup did that.)
export type MeasuredStructure = {
  structure_id: number
  corporation_id: number | null
}

export type StructureMeasuresInput = {
  list: readonly MeasuredStructure[]
  ownRegistrationIds: ReadonlySet<string>
  ownCorporationIds: ReadonlySet<string>
  // ISO window start. The rollup is per UTC day, so the window is every day
  // from the one this falls on — up to a day wider than the exact instant.
  windowStart: string
  taxRates: TaxRates
  // The detail page's narrowing: read only this structure's rows. The index
  // reads every row of the window, since rows at structures with no tile are
  // its "unaccounted" and "taxes paid elsewhere" footers.
  structureId?: string
}

// Every player structure one of our own jobs has ever run in, for the
// roster's discovery of structures we use but no director of ours scans
// (src/app/structure/roster.ts). Invoker-rights RPC over our own rollup rows.
export const fetchJobStructureIds = async (supabase: Supabase): Promise<string[]> => {
  const { data } = await supabase.rpc('structure_measure_structure_ids')
  return map(String, (data ?? []) as Array<number | string>)
}

export const loadStructureMeasures = async (supabase: Supabase, input: StructureMeasuresInput) => {
  const { list, ownRegistrationIds, ownCorporationIds, windowStart, taxRates, structureId } = input
  const windowDay = windowStart.slice(0, 10)

  // Keep the invariant everything below depends on: a figure lands on a
  // structure only if it has a tile on this page. A row anywhere else feeds
  // the footers, never a tile nothing renders.
  const onPage = new Set(map((s: MeasuredStructure) => String(s.structure_id), list))

  // Who owns each structure on the page. corp_structure's RLS is own-corps OR
  // a share's audience, so a tile here is not necessarily ours — and tax our
  // corp paid into an ally's structure is a real expense, not an expense
  // avoided. A structure the directory never resolved has no known owner, so
  // it maps to nothing: read as not ours, which is the only honest answer.
  const structureOwner = new Map<string, string>(
    chain(
      (st: MeasuredStructure) =>
        st.corporation_id != null ? [[String(st.structure_id), String(st.corporation_id)] as [string, string]] : [],
      list
    )
  )
  // Every corporation with a tile here. Tax paid to anyone else went to a
  // landlord this page doesn't list, and is totalled separately.
  const listedOwners = new Set<string>(structureOwner.values())

  // The owner filter is spelled out rather than left to RLS alone: the policy
  // is an OR of the two owner columns, and naming the ids keeps the planner
  // on the two (owner, utc_day) indexes.
  const registrationList = [...ownRegistrationIds].join(',')
  const corporationList = [...ownCorporationIds].join(',')
  const ownerFilter = [
    ...(registrationList ? [`registration_id.in.(${registrationList})`] : []),
    ...(corporationList ? [`corporation_id.in.(${corporationList})`] : []),
  ].join(',')

  // The four reads below depend on nothing but the structure list, so they
  // start together and are awaited where first needed, rather than each
  // waiting its turn behind the one before (the shape #1208 gave the old fold).
  const measureRowsPromise = ownerFilter
    ? fetchAllRows<MeasureWindowRow>((from, to) => {
        const query = supabase
          .from('structure_measure_day')
          .select(
            'structure_id, registration_id, corporation_id, utc_day, jobs, revenue, revenue_by_payer, tax_paid, tax_paid_by_landlord, own_job_tax, own_job_tax_jobs, eiv, eiv_jobs, recovered_tax, recovered_eiv, recovered_jobs, unpriced_jobs'
          )
          .gte('utc_day', windowDay)
          .or(ownerFilter)
        // Digits only: the caller validated the id before it reaches the filter.
        const scoped = structureId != null ? query.eq('structure_id', structureId) : query
        return scoped
          .order('utc_day', { ascending: true })
          .order('structure_id', { ascending: true })
          .order('owner_key', { ascending: true })
          .range(from, to)
          .returns<MeasureWindowRow[]>()
      })
    : Promise.resolve([] as MeasureWindowRow[])

  // The Characters tab: our rows and every co-tenant's at the structures on
  // the page (the view's tenant policy), asked by structure in batches.
  const installerBatchesPromise = Promise.all(
    map(
      (batch: string[]) =>
        fetchAllRows<InstallerWindowRow>((from, to) =>
          supabase
            .from('structure_installer_day')
            .select(
              'structure_id, registration_id, corporation_id, character_id, jobs, eiv, installer_ids, hidden_jobs, hidden_eiv, hidden_installer_ids'
            )
            .gte('utc_day', windowDay)
            .in('structure_id', batch)
            .order('utc_day', { ascending: true })
            .order('structure_id', { ascending: true })
            .order('owner_key', { ascending: true })
            .range(from, to)
            .returns<InstallerWindowRow[]>()
        ),
      splitEvery(RPC_BATCH, [...onPage])
    )
  )
  // Which of our corporations we can actually read a wallet journal for.
  //
  // The recovered estimate is suppressed where the journal already bills the
  // charge exactly, and that is decided by *coverage*, not ownership: a
  // structure owned by a corp this account merely has a character in is not
  // covered unless some token of ours holds the wallet roles to read that
  // corp's journal — and where it does not, the journal is not inexact but
  // empty, so suppressing the estimate hid the tax entirely. One cheap
  // existence probe per candidate corporation; `limit(1)` makes each an index
  // probe. Not scoped to the window or to industry_job_tax on purpose: the
  // question is whether the journal is ingested at all.
  const candidateCoveredCorps = uniq([...structureOwner.values()].filter((corp: string) => ownCorporationIds.has(corp)))
  const coverageProbesPromise = Promise.all(
    map(async (corp: string) => {
      const { data } = await supabase
        .from('corp_wallet_journal')
        .select('corporation_id')
        .eq('corporation_id', Number(corp))
        .limit(1)
      return (data ?? []).length > 0 ? corp : null
    }, candidateCoveredCorps)
  )
  type RegistrationRow = { id: string; name: string; character_id: number | string | null }
  const registrationRowsPromise = supabase
    .from('registration')
    .select('id, name, character_id')
    .returns<RegistrationRow[]>()

  const [measureRows, installerBatches, coverageProbes, { data: registrationRows }] = await Promise.all([
    measureRowsPromise,
    installerBatchesPromise,
    coverageProbesPromise,
    registrationRowsPromise,
  ])
  const installerRows = chain((rows) => rows, installerBatches)
  const journalCoveredCorps = new Set(reject(isNil, coverageProbes) as string[])
  const journalCoveredStructureIds = journalCoveredStructures({ onPage, structureOwner, journalCoveredCorps })

  const window = foldMeasureWindow(measureRows, {
    onPage,
    structureOwner,
    ownCorporationIds,
    journalCoveredStructureIds,
    listedOwners,
  })
  const avoidance = costAvoidance(window.ownReceipts, taxRates)

  // ── Who ran jobs at each structure (the tile's Characters tab) ────────────
  // A registration row is one character, named by our own `registration` row
  // or, for a co-tenant's (RLS hides theirs), through the world-readable
  // character directory, which maps a registration uuid to its character and
  // name and nothing more. A corporation row needs the corp's name from the
  // `corporation` directory; one missing from it falls back to a labelled id.
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
    chain(
      (r: InstallerWindowRow) =>
        r.registration_id != null && !registrationsById.has(String(r.registration_id))
          ? [String(r.registration_id)]
          : [],
      installerRows
    )
  )
  const jobCorporationIds = uniq(
    chain((r: InstallerWindowRow) => (r.corporation_id != null ? [Number(r.corporation_id)] : []), installerRows)
  )
  // Both name lookups want only the installer rows, so they go together.
  const [directoryEntryBatches, corporationNameBatches] = await Promise.all([
    Promise.all(
      map(
        (batch: string[]) =>
          supabase
            .from('character_directory')
            .select('registration_id, name, character_id')
            .in('registration_id', batch)
            .returns<DirectoryEntry[]>(),
        splitEvery(RPC_BATCH, foreignRegistrationIds)
      )
    ),
    Promise.all(
      map(
        (batch: number[]) => supabase.from('corporation').select('corporation_id, name').in('corporation_id', batch),
        splitEvery(RPC_BATCH, jobCorporationIds)
      )
    ),
  ])
  chain(({ data }) => data ?? [], directoryEntryBatches).forEach((entry: DirectoryEntry) => {
    registrationsById.set(entry.registration_id, { name: entry.name, characterId: String(entry.character_id) })
  })
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
  const installersByStructure = foldInstallerWindow(installerRows, {
    registrations: registrationsById,
    corporationNames: jobCorporationNames,
  })

  return {
    ledger: {
      revenueByStructure: window.revenueByStructure,
      taxesPaidByStructure: window.taxesPaidByStructure,
      unlistedLandlords: window.unlistedLandlords,
      unaccounted: window.unaccounted,
      unaccountedByParty: window.unaccountedByParty,
      ownReceiptJobs: window.ownReceiptJobs,
    },
    avoidance,
    eiv: {
      byStructure: window.eivByStructure,
      totalEiv: window.totalEiv,
      totalRecoveredTax: window.totalRecoveredTax,
    },
    eivSkipped: window.unpricedJobs,
    installersByStructure,
  }
}

export type StructureMeasures = Awaited<ReturnType<typeof loadStructureMeasures>>
