import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'
import { DateTime } from '../DateTime'
import retro from '../retro.module.css'

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
  description: string | null
}

const formatIsk = (raw: string | number | null) => {
  if (raw === null) return '—'
  const n = Number(raw)
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const StructuresPage = async () => {
  const supabase = await createClient()

  const { data: auth, error: authError } = await supabase.auth.getUser()
  if (authError || !auth?.user) {
    redirect('/')
  }

  const { data: structures } = await supabase
    .schema('hangar')
    .from('corp_structure')
    .select(
      'structure_id, corporation_id, type_id, system_id, name, state, fuel_expires, unanchors_at, services, last_seen_at'
    )
    .order('corporation_id', { ascending: true })
    .order('structure_id', { ascending: true })

  const list = (structures ?? []) as Structure[]

  // Tax revenue each structure generates. Each industry-tax journal entry references a job by id in
  // its description; outer-join those job ids to the industry_job table to find the structure
  // (station_id, falling back to facility_id) the job is installed in, then sum the journal amounts.
  // Bigint ids can come back from PostgREST as strings, so key every map by string.
  const structureIds = list.map((s) => Number(s.structure_id))
  const { data: jobs } = structureIds.length
    ? await supabase
        .schema('hangar')
        .from('industry_job')
        .select('job_id, station_id, facility_id')
        .or(`station_id.in.(${structureIds.join(',')}),facility_id.in.(${structureIds.join(',')})`)
    : { data: [] }

  const structureByJob = new Map<string, string>()
  for (const j of (jobs ?? []) as JobRow[]) {
    const structureId = j.station_id ?? j.facility_id
    if (structureId != null) structureByJob.set(String(j.job_id), String(structureId))
  }

  const { data: journal } = await supabase
    .schema('hangar')
    .from('corp_wallet_journal')
    .select('amount, description')
    .eq('ref_type', 'industry_job_tax')

  const totalByStructure = new Map<string, number>()
  let unaccounted = 0
  for (const entry of (journal ?? []) as JournalRow[]) {
    const amount = Number(entry.amount ?? 0)
    // The job id is interpolated into the description; find the token that joins to a known job.
    let structureId: string | undefined
    for (const token of entry.description?.match(/\d+/g) ?? []) {
      structureId = structureByJob.get(token)
      if (structureId) break
    }
    if (structureId) {
      totalByStructure.set(structureId, (totalByStructure.get(structureId) ?? 0) + amount)
    } else {
      // Tax we received but can't tie to one of our structures (e.g. jobs not in our table).
      unaccounted += amount
    }
  }

  // Revenue from structure clone bays (jump clone install/activation fees etc.).
  const { data: cloneJournal } = await supabase
    .schema('hangar')
    .from('corp_wallet_journal')
    .select('amount')
    .ilike('ref_type', '%clone%')

  const cloneRevenue = ((cloneJournal ?? []) as Array<{ amount: number | string | null }>).reduce(
    (sum, entry) => sum + Number(entry.amount ?? 0),
    0
  )

  return (
    <>
      <h1>Structures</h1>
      {list.length > 0 ? (
        <>
          <table className={retro.retro} border={3} cellPadding={2} cellSpacing={0}>
            <thead>
              <tr>
                <th>Structure ID</th>
                <th>Station ID</th>
                <th>Name</th>
                <th>Tax Revenue</th>
                <th>Corp ID</th>
                <th>Type ID</th>
                <th>System ID</th>
                <th>State</th>
                <th>Fuel Expires</th>
                <th>Unanchors At</th>
                <th>Services</th>
                <th>Last Seen</th>
              </tr>
            </thead>
            <tbody>
              {list.map((s) => (
                <tr key={`structure-${s.structure_id}`}>
                  <td>
                    <a href={`/structures/${s.structure_id}`}>{s.structure_id}</a>
                  </td>
                  {/* Upwell structures share their structure_id with the station/facility id industry jobs run at. */}
                  <td>{s.structure_id}</td>
                  <td>{s.name ?? '—'}</td>
                  <td>{formatIsk(totalByStructure.get(String(s.structure_id)) ?? 0)}</td>
                  <td>{s.corporation_id}</td>
                  <td>{s.type_id}</td>
                  <td>{s.system_id}</td>
                  <td>{s.state ?? '—'}</td>
                  <td>
                    <DateTime value={s.fuel_expires} />
                  </td>
                  <td>
                    <DateTime value={s.unanchors_at} />
                  </td>
                  <td>{s.services?.map((svc) => svc.name).join(', ') ?? '—'}</td>
                  <td>
                    <DateTime value={s.last_seen_at} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>Unaccounted tax revenue: {formatIsk(unaccounted)} ISK</p>
          <p>Clone revenue: {formatIsk(cloneRevenue)} ISK</p>
          <p className={retro.bestViewedIn}>Best viewed in Netscape Navigator 3.0 at 800&times;600</p>
        </>
      ) : (
        <p>
          No structures visible. Re-link a director character on the <a href="/character">Characters</a> page so the
          hourly job can fetch them.
        </p>
      )}
    </>
  )
}
export default StructuresPage
