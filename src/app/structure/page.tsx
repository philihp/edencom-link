import Link from 'next/link'
import { redirect } from 'next/navigation'
import { chain, concat, filter, forEach, map, splitEvery, uniq } from 'ramda'

import { createClient } from '@/utils/supabase/server'

import { establishedUser } from '../account/lib/establishedUser'
import { DateTime } from '../DateTime'
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
import { StructureSilhouette } from './silhouette'
import { Sparkline } from './sparkline'
import { WindowSelect } from './windowSelect'
import { structureWindowDays } from './windows'
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
  corporation_id: number
  type_id: number
  system_id: number
  name: string | null
  state: string | null
  fuel_expires: string | null
  unanchors_at: string | null
  services: Array<{ name: string; state: string }> | null
  last_seen_at: string
}

type JobRow = {
  job_id: number | string
  station_id: number | string | null
  facility_id: number | string | null
}

type JournalRow = {
  amount: number | string | null
  context_id: number | string | null
  description: string | null
  first_party_id: number | string | null
}

type RigRow = {
  structure_id: number | string
  location_flag: string
  type_id: number | string
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

  const { data: structures } = await supabase
    .from('corp_structure')
    .select('structure_id, corporation_id, type_id, system_id, name, state, unanchors_at, services, last_seen_at')
    .order('corporation_id', { ascending: true })
    .order('structure_id', { ascending: true })

  const list = (structures ?? []) as Structure[]

  // Tax revenue each structure generates. Each industry-tax journal entry references its job via
  // context_id (context_id_type = industry_job_id); outer-join those job ids to the industry-job
  // tables to find the structure (station_id, falling back to facility_id) the job is installed in,
  // then sum the journal amounts. The installer pays the tax and isn't necessarily one of this app's
  // linked characters (character_industry_job only covers those) — anyone in the corp can run a job
  // here (reactions in a refinery are often run by a dedicated alt), so corp_industry_job (pulled by
  // a director, covering every corp member) is unioned in too, mirroring /structure/revenue.
  // Otherwise a corp-run job's tax lands in "unaccounted" instead of its structure. Bigint ids can
  // come back from PostgREST as strings, so key every map by string.
  //
  // Both selects are drained rather than issued once: a corp with any history has far more than
  // max_rows (1000) jobs across its structures — 3.5k here — and a single request silently returns
  // an arbitrary 1000 of them, so most jobs failed to resolve and their tax fell into
  // "unaccounted". Paging needs a total order, hence order by job_id.
  const structureIds = list.map((s) => Number(s.structure_id))
  const jobStructureFilter = `station_id.in.(${structureIds.join(',')}),facility_id.in.(${structureIds.join(',')})`
  const fetchJobs = (table: 'character_industry_job' | 'corp_industry_job') =>
    fetchAllRows<JobRow>((from, to) =>
      supabase
        .from(table)
        .select('job_id, station_id, facility_id')
        .or(jobStructureFilter)
        .order('job_id', { ascending: true })
        .range(from, to)
    )
  const [characterJobs, corpJobs] = structureIds.length
    ? await Promise.all([fetchJobs('character_industry_job'), fetchJobs('corp_industry_job')])
    : [[], []]

  const structureByJob = new Map<string, string>()
  forEach(
    (j: JobRow) => {
      const structureId = j.station_id ?? j.facility_id
      if (structureId != null) structureByJob.set(String(j.job_id), String(structureId))
    },
    concat(characterJobs, corpJobs)
  )

  // Fuel timers live in corp_structure_status now (own-corp only). RLS returns a
  // row only for structures the caller's corp owns, so an alliance-mate's
  // structure that's visible via corp_structure simply has no fuel here.
  const { data: statusRows } = structureIds.length
    ? await supabase.from('corp_structure_status').select('structure_id, fuel_expires').in('structure_id', structureIds)
    : { data: [] }
  const fuelByStructure = new Map<string, string | null>(
    ((statusRows ?? []) as Array<{ structure_id: number | string; fuel_expires: string | null }>).map((r) => [
      String(r.structure_id),
      r.fuel_expires,
    ])
  )
  for (const s of list) s.fuel_expires = fuelByStructure.get(String(s.structure_id)) ?? null

  // Rigs fitted to each structure (pulled from corp assets by the corp-assets job).
  const { data: rigRows } = structureIds.length
    ? await supabase
        .from('corp_structure_rig')
        .select('structure_id, location_flag, type_id')
        .in('structure_id', structureIds)
        .order('location_flag', { ascending: true })
    : { data: [] }

  const rigList = (rigRows ?? []) as RigRow[]
  const rigTypeNames = await fetchTypeNames(rigList.map((r) => Number(r.type_id)))
  const rigsByStructure = new Map<string, string[]>()
  for (const r of rigList) {
    const key = String(r.structure_id)
    const name = rigTypeNames[Number(r.type_id)] ?? String(r.type_id)
    const existing = rigsByStructure.get(key)
    if (existing) existing.push(name)
    else rigsByStructure.set(key, [name])
  }

  const systemNames = await fetchSystemNames(list.map((s) => Number(s.system_id)))
  const structureTypeNames = await fetchTypeNames(list.map((s) => Number(s.type_id)))

  // Latest industry cost indices for the systems we hold structures in. We only
  // show, per structure, the activities its fitted service modules enable.
  const indexesBySystem = await fetchLatestSystemIndexes(
    supabase,
    list.map((s) => Number(s.system_id))
  )
  // The same window that drives the revenue footer also scopes the index
  // sparklines. Widen the bucket for longer windows so the point count stays
  // sane on a 100px sparkline (~180 points max: 24h/day ÷ bucketHours).
  const indexHistoryBySystem = await fetchSystemIndexHistory(
    supabase,
    list.map((s) => Number(s.system_id)),
    { days: windowDays, bucketHours: Math.max(1, Math.ceil((windowDays * 24) / 180)) }
  )

  // Receipts only. industry_job_tax cuts both ways in a corp wallet: a positive entry is tax someone
  // paid to run a job in one of our structures, a negative one is tax WE paid to run a job in
  // someone else's. Only the first is revenue. Summing both netted a corp's own industry spend
  // against its landlord income — and a corp that rents slots without owning any occupied structure
  // showed a negative figure under a heading that reads "Revenue".
  const journal = await fetchAllRows<JournalRow>((from, to) =>
    supabase
      .from('corp_wallet_journal')
      .select('amount, context_id, description, first_party_id')
      .eq('ref_type', 'industry_job_tax')
      .gt('amount', 0)
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

  // Keep the invariant the structure-seeded queries above establish: every value in the map is a
  // structure on this page. A job taxed into our wallet from somewhere not in `list` (an NPC
  // station, a structure we've stopped monitoring) stays unaccounted rather than accruing to a
  // row nothing renders — as does one ESI gave no location at all.
  const onPage = new Set(map(String, structureIds))
  const locationOf = (j: JobRow) => j.station_id ?? j.facility_id
  forEach(
    (j) => structureByJob.set(String(j.job_id), String(locationOf(j))),
    filter(
      (j: JobRow) => locationOf(j) != null && onPage.has(String(locationOf(j))),
      chain(({ data }) => (data ?? []) as JobRow[], taxedBatches)
    )
  )

  const totalByStructure = new Map<string, number>()
  // Unaccounted tax broken down by the party that paid it (the character/corp that ran the job).
  const unaccountedByParty = new Map<string, number>()
  let unaccounted = 0
  for (const entry of (journal ?? []) as JournalRow[]) {
    const amount = Number(entry.amount ?? 0)
    // The job id is the entry's context_id; fall back to parsing it out of the description for older
    // entries (or any ref_type variants) where ESI didn't populate context_id.
    let structureId = entry.context_id != null ? structureByJob.get(String(entry.context_id)) : undefined
    if (!structureId) {
      for (const token of entry.description?.match(/\d+/g) ?? []) {
        structureId = structureByJob.get(token)
        if (structureId) break
      }
    }
    if (structureId) {
      totalByStructure.set(structureId, (totalByStructure.get(structureId) ?? 0) + amount)
    } else {
      // Tax we received but can't tie to one of our structures (e.g. jobs not in our table).
      unaccounted += amount
      const party = entry.first_party_id != null ? String(entry.first_party_id) : 'unknown'
      unaccountedByParty.set(party, (unaccountedByParty.get(party) ?? 0) + amount)
    }
  }

  // Largest payers first.
  const unaccountedParties = [...unaccountedByParty.entries()].sort((a, b) => b[1] - a[1])

  // Resolve each payer (a character) to their name and the corp they fly for. Names come from the
  // universe_name table (populated by the universe-names job) and corp affiliations from
  // character_affiliation (populated by the character-directory job); ids not yet resolved fall
  // back to showing the raw id.
  const partyIds = unaccountedParties.map(([party]) => party).filter((p) => p !== 'unknown')
  const payerNames = new Map<string, string>()
  const payerCorps = new Map<string, string>()
  if (partyIds.length > 0) {
    const partyIdNums = partyIds.map(Number)
    const { data: charNames } = await supabase.from('universe_name').select('id, name').in('id', partyIdNums)
    for (const r of (charNames ?? []) as Array<{ id: number | string; name: string }>) {
      payerNames.set(String(r.id), r.name)
    }

    const { data: affiliations } = await supabase
      .from('character_affiliation')
      .select('character_id, corporation_id')
      .in('character_id', partyIdNums)
    const corpByParty = new Map<string, string>()
    const corpIds = new Set<number>()
    for (const a of (affiliations ?? []) as Array<{ character_id: number | string; corporation_id: number | string }>) {
      corpByParty.set(String(a.character_id), String(a.corporation_id))
      corpIds.add(Number(a.corporation_id))
    }
    if (corpIds.size > 0) {
      const { data: corpNames } = await supabase
        .from('universe_name')
        .select('id, name')
        .in('id', [...corpIds])
      const corpNameById = new Map<string, string>()
      for (const r of (corpNames ?? []) as Array<{ id: number | string; name: string }>) {
        corpNameById.set(String(r.id), r.name)
      }
      for (const [party, corpId] of corpByParty) {
        const name = corpNameById.get(corpId)
        if (name) payerCorps.set(party, name)
      }
    }
  }

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

  const cloneRevenue = cloneJournal.reduce((sum, entry) => sum + Number(entry.amount ?? 0), 0)

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
          <ul className={styles.grid}>
            {list.map((s) => {
              const rigs = rigsByStructure.get(String(s.structure_id)) ?? []
              const services = s.services?.map((svc) => svc.name) ?? []
              const indexActivities = structureIndexActivities(s.services)
              const systemIndexes = indexesBySystem.get(Number(s.system_id))
              const systemHistory = indexHistoryBySystem.get(Number(s.system_id))
              return (
                <li key={`structure-${s.structure_id}`} className={styles.tile}>
                  <StructureSilhouette typeId={s.type_id} className={styles.silhouette} />
                  <div className={styles.head}>
                    <div>
                      <Link href={`/structure/${s.structure_id}`} className={styles.name}>
                        {s.name ?? `Structure #${s.structure_id}`}
                        <LinkSpinner />
                      </Link>
                      {/* Upwell structures share their structure_id with the station/facility id industry jobs run at. */}
                      <span className={styles.subId}>#{s.structure_id}</span>
                    </div>
                  </div>

                  <div className={styles.fields}>
                    {totalByStructure.get(String(s.structure_id)) && (
                      <>
                        <span className={styles.label}>Revenue</span>
                        <span className={`${styles.value} ${styles.num}`}>
                          {formatIsk(totalByStructure.get(String(s.structure_id)) ?? 0)}
                        </span>
                      </>
                    )}
                    <span className={styles.label}>Type</span>
                    <span className={styles.value}>
                      <Name name={structureTypeNames[Number(s.type_id)]} id={s.type_id} />
                    </span>
                    <span className={styles.label}>System</span>
                    <span className={styles.value}>
                      <SystemName name={systemNames[Number(s.system_id)]} id={s.system_id} />
                    </span>
                    {s.fuel_expires && (
                      <>
                        <span className={styles.label}>Fuel Expires</span>
                        <span className={styles.value}>
                          <DateTime value={s.fuel_expires} />
                        </span>
                      </>
                    )}
                  </div>

                  {services.length > 0 && (
                    <div className={styles.section}>
                      <span className={styles.sectionLabel}>Services</span>
                      {
                        <ul className={styles.chips}>
                          {services.map((svc, i) => (
                            <li key={`svc-${s.structure_id}-${i}`} className={styles.chip}>
                              {svc}
                            </li>
                          ))}
                        </ul>
                      }
                    </div>
                  )}

                  {rigs.length > 0 && (
                    <div className={styles.section}>
                      <span className={styles.sectionLabel}>Rigs</span>
                      <ul className={styles.chips}>
                        {rigs.map((rig, i) => (
                          <li key={`rig-${s.structure_id}-${i}`} className={styles.chip}>
                            {rig}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

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

          <div className={styles.footer}>
            {unaccountedParties.length > 0 && (
              <>
                <span>Unaccounted tax revenue:</span>
                <span className={styles.footerValue}>{formatIsk(unaccounted)}</span>
              </>
            )}
            <span>Clone revenue:</span>
            <span className={styles.footerValue}>{formatKisk(cloneRevenue)}</span>
          </div>
          {unaccountedParties.length > 0 && (
            <p className={styles.unaccountedNote}>
              <em>
                Unaccounted revenue comes from industry jobs started by players we can&rsquo;t see, so we can&rsquo;t
                tie the tax back to one of our structures.
              </em>
            </p>
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
          No structures visible. Re-link a director character on the <Link href="/character">Characters</Link> page so
          the hourly job can fetch them.
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
