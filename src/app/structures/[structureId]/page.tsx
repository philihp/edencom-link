import Link from 'next/link'
import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'
import { ACTIVITY_NAMES, formatDate } from '../../industry/jobFields'
import { fetchTypeNames } from '../../typeNames'
import retro from '../../retro.module.css'

type Structure = {
  structure_id: number
  corporation_id: number
  type_id: number
  system_id: number
  profile_id: number | null
  name: string | null
  state: string | null
  fuel_expires: string | null
  unanchors_at: string | null
  reinforce_hour: number | null
  next_reinforce_hour: number | null
  next_reinforce_apply: string | null
  next_reinforce_weekday: number | null
  services: Array<{ name: string; state: string }> | null
  last_seen_at: string
  updated_at: string | null
}

type Job = {
  job_id: number | string
  character_id: string
  activity_id: number
  blueprint_type_id: number | string
  product_type_id: number | string | null
  runs: number
  status: string
  start_date: string
  end_date: string
  station_id: number | string | null
  facility_id: number | string | null
}

type StructureParams = {
  params: Promise<{
    structureId: string
  }>
}

const show = (value: string | number | null | undefined) => (value === null || value === undefined ? '—' : value)

const StructurePage = async ({ params }: StructureParams) => {
  const { structureId } = await params
  const supabase = await createClient()

  const { data: auth, error: authError } = await supabase.auth.getUser()
  if (authError || !auth?.user) {
    redirect('/')
  }

  // structure ids are bigints; only digits are valid, and validating guards the .or() filter below.
  const validId = /^\d+$/.test(structureId)

  const { data: structure } = validId
    ? await supabase
        .schema('hangar')
        .from('corp_structure')
        .select(
          'structure_id, corporation_id, type_id, system_id, profile_id, name, state, fuel_expires, unanchors_at, reinforce_hour, next_reinforce_hour, next_reinforce_apply, next_reinforce_weekday, services, last_seen_at, updated_at'
        )
        .eq('structure_id', structureId)
        .maybeSingle()
    : { data: null }

  if (!structure) {
    return (
      <>
        <h1>Structure not found</h1>
        <p>
          No structure {structureId} is visible. It may not exist, or you may need to re-link a director character on
          the <a href="/character">Characters</a> page. Back to <Link href="/structures">Structures</Link>.
        </p>
      </>
    )
  }

  const s = structure as Structure

  const { data: jobsData } = await supabase
    .schema('hangar')
    .from('industry_job')
    .select(
      'job_id, character_id, activity_id, blueprint_type_id, product_type_id, runs, status, start_date, end_date, station_id, facility_id'
    )
    .or(`station_id.eq.${structureId},facility_id.eq.${structureId}`)
    .order('end_date', { ascending: true })

  const jobs = (jobsData ?? []) as Job[]

  const { data: characters } = await supabase.schema('hangar').from('character').select('id, name')
  const characterName: Record<string, string> = Object.fromEntries((characters ?? []).map((c) => [c.id, c.name]))

  const typeNames = await fetchTypeNames([
    Number(s.type_id),
    ...jobs.flatMap((j) => {
      const ids = [Number(j.blueprint_type_id)]
      if (j.product_type_id != null) ids.push(Number(j.product_type_id))
      return ids
    }),
  ])

  const typeName = typeNames[Number(s.type_id)]

  return (
    <>
      <h1>{s.name ?? `Structure #${s.structure_id}`}</h1>
      <p>
        <Link href="/structures">&laquo; Back to Structures</Link>
      </p>

      <table className={retro.retro} border={3} cellPadding={0} cellSpacing={2}>
        <tbody>
          <tr>
            <th>Structure ID</th>
            <td>{s.structure_id}</td>
          </tr>
          <tr>
            <th>Name</th>
            <td>{show(s.name)}</td>
          </tr>
          <tr>
            <th>Type</th>
            <td>
              {typeName ? `${typeName} ` : ''}#{s.type_id}
            </td>
          </tr>
          <tr>
            <th>System ID</th>
            <td>{s.system_id}</td>
          </tr>
          <tr>
            <th>Corp ID</th>
            <td>{s.corporation_id}</td>
          </tr>
          <tr>
            <th>Profile ID</th>
            <td>{show(s.profile_id)}</td>
          </tr>
          <tr>
            <th>State</th>
            <td>{show(s.state)}</td>
          </tr>
          <tr>
            <th>Fuel Expires</th>
            <td>{show(s.fuel_expires)}</td>
          </tr>
          <tr>
            <th>Unanchors At</th>
            <td>{show(s.unanchors_at)}</td>
          </tr>
          <tr>
            <th>Reinforce Hour</th>
            <td>{show(s.reinforce_hour)}</td>
          </tr>
          <tr>
            <th>Next Reinforce Hour</th>
            <td>{show(s.next_reinforce_hour)}</td>
          </tr>
          <tr>
            <th>Next Reinforce Weekday</th>
            <td>{show(s.next_reinforce_weekday)}</td>
          </tr>
          <tr>
            <th>Next Reinforce Apply</th>
            <td>{show(s.next_reinforce_apply)}</td>
          </tr>
          <tr>
            <th>Services</th>
            <td>{s.services?.map((svc) => `${svc.name} (${svc.state})`).join(', ') ?? '—'}</td>
          </tr>
          <tr>
            <th>Last Seen</th>
            <td>{s.last_seen_at}</td>
          </tr>
          <tr>
            <th>Updated At</th>
            <td>{show(s.updated_at)}</td>
          </tr>
        </tbody>
      </table>

      <h2>Industry Jobs</h2>
      {jobs.length > 0 ? (
        <table className={retro.retro} border={3} cellPadding={0} cellSpacing={2}>
          <thead>
            <tr>
              <th>Character</th>
              <th>Activity</th>
              <th>Blueprint</th>
              <th>Product</th>
              <th>Runs</th>
              <th>Status</th>
              <th>Start</th>
              <th>End</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={`job-${j.job_id}`}>
                <td>{characterName[j.character_id] ?? '—'}</td>
                <td>{ACTIVITY_NAMES[j.activity_id] ?? `#${j.activity_id}`}</td>
                <td>{typeNames[Number(j.blueprint_type_id)] ?? `#${j.blueprint_type_id}`}</td>
                <td>
                  {j.product_type_id != null ? (typeNames[Number(j.product_type_id)] ?? `#${j.product_type_id}`) : '—'}
                </td>
                <td>{j.runs}</td>
                <td>{j.status}</td>
                <td>{formatDate(j.start_date)}</td>
                <td>{formatDate(j.end_date)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p>No industry jobs known at this structure.</p>
      )}

      <p className={retro.bestViewedIn}>Best viewed in Netscape Navigator 3.0 at 800&times;600</p>
    </>
  )
}

export default StructurePage
