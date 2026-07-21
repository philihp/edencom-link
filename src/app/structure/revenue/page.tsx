import Link from 'next/link'
import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'
import { DateTime } from '../../DateTime'
import { formatIskValue } from '../../isk'
import { Name } from '../../names'
import { fetchTypeNames } from '../../typeNames'
import retro from '../../retro.module.css'
import structureStyles from '../structures.module.css'
import styles from './revenue.module.css'

const PAGE_SIZE = 1000

// Page through a select past PostgREST's max_rows (1000) cap until a short page
// signals the end (cf. src/app/market/page.tsx).
const fetchAllRows = async <T,>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>
): Promise<T[]> => {
  const rows: T[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await build(from, from + PAGE_SIZE - 1)
    if (error || !data || data.length === 0) break
    rows.push(...data)
    if (data.length < PAGE_SIZE) break
  }
  return rows
}

type JournalRow = {
  corporation_id: number | string
  division: number | string
  entry_id: number | string
  date: string
  amount: number | string | null
  context_id: number | string | null
  description: string | null
  first_party_id: number | string | null
}

type JobRow = {
  job_id: number | string
  station_id: number | string | null
  facility_id: number | string | null
  runs: number
  product_type_id: number | string | null
}

// EVE runs on UTC, so days are UTC days. Journal dates come back from
// PostgREST as ISO strings in UTC, so the day is just the first ten chars.
const utcDay = (iso: string) => new Date(iso).toISOString().slice(0, 10)
const nextUtcDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)

type RevenueParams = {
  searchParams: Promise<{ day?: string }>
}

const RevenuePage = async ({ searchParams }: RevenueParams) => {
  const { day: dayParam } = await searchParams
  const supabase = await createClient()

  const { data: auth, error: authError } = await supabase.auth.getUser()
  if (authError || !auth?.user) {
    redirect('/')
  }

  // The distinct days that have tax events, newest first, drive the pager.
  // Only the date column is pulled, paged past the PostgREST row cap.
  const dateRows = await fetchAllRows<{ date: string }>((from, to) =>
    supabase
      .from('corp_wallet_journal')
      .select('date')
      .eq('ref_type', 'industry_job_tax')
      .order('date', { ascending: false })
      .range(from, to)
  )
  const days = [...new Set(dateRows.map((r) => utcDay(r.date)))]

  const requestedDay = dayParam && /^\d{4}-\d{2}-\d{2}$/.test(dayParam) ? dayParam : undefined
  const day = requestedDay ?? days[0]

  // Days are sorted descending, so "newer" is the last day after the selected
  // one and "older" the first day before it — this also lands on the nearest
  // real day when the URL names a day with no events.
  const newer = [...days].reverse().find((d) => d > (day ?? ''))
  const older = days.find((d) => d < (day ?? '~'))

  const entries = day
    ? await fetchAllRows<JournalRow>((from, to) =>
        supabase
          .from('corp_wallet_journal')
          .select('corporation_id, division, entry_id, date, amount, context_id, description, first_party_id')
          .eq('ref_type', 'industry_job_tax')
          .gte('date', `${day}T00:00:00Z`)
          .lt('date', `${nextUtcDay(day)}T00:00:00Z`)
          .order('date', { ascending: false })
          .order('entry_id', { ascending: false })
          .range(from, to)
      )
    : []

  // Each tax entry references its industry job via context_id
  // (context_id_type = industry_job_id); older entries may only carry the job
  // id inside the description text, so collect those numeric tokens too and
  // let the lookup decide which token is really a job id (cf. /structure). The
  // job's installer pays the tax, and they aren't necessarily one of this app's
  // linked characters (character_industry_job only covers those) — anyone in the
  // corp can run a job here, so corp_industry_job (pulled by a director,
  // covering every corp member) is checked too.
  const jobIds = new Set<string>()
  for (const entry of entries) {
    if (entry.context_id != null) jobIds.add(String(entry.context_id))
    for (const token of entry.description?.match(/\d+/g) ?? []) jobIds.add(token)
  }
  const [{ data: characterJobRows }, { data: corpJobRows }] = jobIds.size
    ? await Promise.all([
        supabase
          .from('character_industry_job')
          .select('job_id, station_id, facility_id, runs, product_type_id')
          .in('job_id', [...jobIds]),
        supabase
          .from('corp_industry_job')
          .select('job_id, station_id, facility_id, runs, product_type_id')
          .in('job_id', [...jobIds]),
      ])
    : [{ data: [] }, { data: [] }]

  const jobById = new Map<string, JobRow>()
  for (const j of [...((characterJobRows ?? []) as JobRow[]), ...((corpJobRows ?? []) as JobRow[])]) {
    jobById.set(String(j.job_id), j)
  }

  const jobForEntry = (entry: JournalRow): JobRow | undefined => {
    if (entry.context_id != null) {
      const job = jobById.get(String(entry.context_id))
      if (job) return job
    }
    for (const token of entry.description?.match(/\d+/g) ?? []) {
      const job = jobById.get(token)
      if (job) return job
    }
    return undefined
  }

  // Names for the structures those jobs ran in (station_id, falling back to
  // facility_id — Upwell structures share ids between the two).
  const structureIds = new Set<number>()
  for (const j of jobById.values()) {
    const structureId = j.station_id ?? j.facility_id
    if (structureId != null) structureIds.add(Number(structureId))
  }
  const { data: structureRows } = structureIds.size
    ? await supabase
        .from('corp_structure')
        .select('structure_id, name')
        .in('structure_id', [...structureIds])
    : { data: [] }
  const structureNames = new Map<string, string | null>()
  for (const s of (structureRows ?? []) as Array<{ structure_id: number | string; name: string | null }>) {
    structureNames.set(String(s.structure_id), s.name)
  }

  // Resolve each payer (a character) to their name and the corp they fly for,
  // from universe_name (the universe-names job) and character_affiliation (the
  // character-directory job).
  const partyIds = [...new Set(entries.map((e) => e.first_party_id).filter((p) => p != null))].map(Number)
  const payerNames = new Map<string, string>()
  const payerCorps = new Map<string, string>()
  if (partyIds.length > 0) {
    const { data: charNames } = await supabase.from('universe_name').select('id, name').in('id', partyIds)
    for (const r of (charNames ?? []) as Array<{ id: number | string; name: string }>) {
      payerNames.set(String(r.id), r.name)
    }

    const { data: affiliations } = await supabase
      .from('character_affiliation')
      .select('character_id, corporation_id')
      .in('character_id', partyIds)
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

  const typeNames = await fetchTypeNames(
    [...jobById.values()].map((j) => Number(j.product_type_id)).filter((id) => Number.isFinite(id))
  )

  const dayTotal = entries.reduce((sum, e) => sum + Number(e.amount ?? 0), 0)

  const pager = day && (
    <nav className={styles.pager}>
      {older ? <Link href={`/structure/revenue?day=${older}`}>&laquo; {older}</Link> : <span>&laquo;</span>}
      <span className={`${styles.pagerCurrent} serif`}>{day}</span>
      {newer ? <Link href={`/structure/revenue?day=${newer}`}>{newer} &raquo;</Link> : <span>&raquo;</span>}
    </nav>
  )

  return (
    <>
      <h1>Tax Revenue</h1>
      <p>
        <Link href="/structure">&laquo; Back to Structures</Link>
      </p>

      {day ? (
        <>
          {pager}
          {entries.length > 0 ? (
            <table className={retro.retro}>
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>Payer</th>
                  <th className={retro.num}>Amount (ISK)</th>
                  <th>Structure</th>
                  <th>Output</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => {
                  const job = jobForEntry(entry)
                  const structureId = job ? (job.station_id ?? job.facility_id) : null
                  const party = entry.first_party_id != null ? String(entry.first_party_id) : undefined
                  const payerName = party ? payerNames.get(party) : undefined
                  const payerCorp = party ? payerCorps.get(party) : undefined
                  return (
                    <tr key={`entry-${entry.corporation_id}-${entry.division}-${entry.entry_id}`}>
                      <td>
                        <DateTime value={entry.date} />
                      </td>
                      <td>
                        <span className={structureStyles.payer}>
                          <Name name={payerName} id={party} />
                          {payerCorp && <span className={structureStyles.payerCorp}>{payerCorp}</span>}
                        </span>
                      </td>
                      <td className={retro.num}>{formatIskValue(entry.amount)}</td>
                      <td>
                        {structureId != null ? (
                          <Link href={`/structure/${structureId}`}>
                            <Name name={structureNames.get(String(structureId))} id={structureId} />
                          </Link>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        {job?.product_type_id != null ? (
                          <>
                            <span className={retro.num}>{job.runs}</span> &times;{' '}
                            <Name name={typeNames[Number(job.product_type_id)]} id={job.product_type_id} />
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr>
                  <th>Total</th>
                  <th />
                  <th className={retro.num}>{formatIskValue(dayTotal)}</th>
                  <th />
                  <th />
                </tr>
              </tfoot>
            </table>
          ) : (
            <p>No tax revenue events on {day}.</p>
          )}
          {pager}
        </>
      ) : (
        <p>No tax revenue events found in the corp wallet journal.</p>
      )}
    </>
  )
}
export default RevenuePage
