import Link from 'next/link'
import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'
import { DateTime } from '../../DateTime'
import { ACTIVITY_NAMES } from '../../industry/jobFields'
import { CharacterName, Name, SystemName } from '../../names'
import { fetchSystemNames } from '../../systemNames'
import { fetchTypeNames } from '../../typeNames'
import {
  fetchLatestSystemIndexes,
  formatIndex,
  INDEX_ACTIVITY_LABELS,
  structureIndexActivities,
} from '../industryIndex'
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

type Rig = {
  structure_id: number | string
  location_flag: string
  type_id: number | string
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
          the <a href="/character">Characters</a> page. Back to <Link href="/structure">Structures</Link>.
        </p>
      </>
    )
  }

  const s = structure as Structure

  const { data: jobsData } = await supabase
    .from('industry_job')
    .select(
      'job_id, character_id, activity_id, blueprint_type_id, product_type_id, runs, status, start_date, end_date, station_id, facility_id'
    )
    .or(`station_id.eq.${structureId},facility_id.eq.${structureId}`)
    .eq('status', 'active')
    .order('end_date', { ascending: true })

  const jobs = (jobsData ?? []) as Job[]

  const { data: characters } = await supabase.from('registration').select('id, name')
  const characterName: Record<string, string> = Object.fromEntries((characters ?? []).map((c) => [c.id, c.name]))

  // Rigs fitted to this structure (pulled from corp assets by the structures job).
  const { data: rigData } = await supabase
    .from('corp_structure_rig')
    .select('structure_id, location_flag, type_id')
    .eq('structure_id', structureId)
    .order('location_flag', { ascending: true })

  const rigs = (rigData ?? []) as Rig[]

  const typeNames = await fetchTypeNames([
    Number(s.type_id),
    ...rigs.map((r) => Number(r.type_id)),
    ...jobs.flatMap((j) => {
      const ids = [Number(j.blueprint_type_id)]
      if (j.product_type_id != null) ids.push(Number(j.product_type_id))
      return ids
    }),
  ])

  const systemNames = await fetchSystemNames([Number(s.system_id)])

  const typeName = typeNames[Number(s.type_id)]
  const systemName = systemNames[Number(s.system_id)]

  // Industry cost indices relevant to this structure (those its fitted service
  // modules enable), pulled from the latest snapshot for its system.
  const indexActivities = structureIndexActivities(s.services)
  const indexesBySystem = await fetchLatestSystemIndexes(supabase, [Number(s.system_id)])
  const systemIndexes = indexesBySystem.get(Number(s.system_id))

  return (
    <>
      <h1 className="serif">{s.name ?? `Structure #${s.structure_id}`}</h1>
      <p>
        <Link href="/structure">&laquo; Back to Structures</Link>
      </p>

      <table className={retro.retro}>
        <tbody>
          <tr>
            <th>Structure ID</th>
            <td>{s.structure_id}</td>
          </tr>
          <tr>
            <th>Type</th>
            <td>
              <Name name={typeName} id={s.type_id} />
            </td>
          </tr>
          <tr>
            <th>System</th>
            <td>
              <SystemName name={systemName} id={s.system_id} />
            </td>
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
            <td>
              <DateTime value={s.fuel_expires} />
            </td>
          </tr>
          <tr>
            <th>Unanchors At</th>
            <td>
              <DateTime value={s.unanchors_at} />
            </td>
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
            <td>
              <DateTime value={s.next_reinforce_apply} />
            </td>
          </tr>
          <tr>
            <th>Services</th>
            <td>{s.services?.map((svc) => `${svc.name} (${svc.state})`).join(', ') ?? '—'}</td>
          </tr>
          <tr>
            <th>Rigs</th>
            <td>
              {rigs.length > 0 ? rigs.map((r) => typeNames[Number(r.type_id)] ?? `#${r.type_id}`).join(', ') : '—'}
            </td>
          </tr>
          <tr>
            <th>Industry Indexes</th>
            <td>
              {indexActivities.length > 0
                ? indexActivities
                    .map((activity) => {
                      const cost = systemIndexes?.get(activity)
                      return `${INDEX_ACTIVITY_LABELS[activity]} ${cost != null ? formatIndex(cost) : '—'}`
                    })
                    .join(', ')
                : '—'}
            </td>
          </tr>
          <tr>
            <th>Last Seen</th>
            <td>
              <DateTime value={s.last_seen_at} />
            </td>
          </tr>
          <tr>
            <th>Updated At</th>
            <td>
              <DateTime value={s.updated_at} />
            </td>
          </tr>
        </tbody>
      </table>

      <h2>Industry Jobs</h2>
      {jobs.length > 0 ? (
        <table className={retro.retro}>
          <thead>
            <tr>
              <th>Character</th>
              <th>Activity</th>
              <th>Blueprint</th>
              <th>Product</th>
              <th className={retro.num}>Runs</th>
              <th>Status</th>
              <th>Start</th>
              <th>End</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={`job-${j.job_id}`}>
                <td>
                  <CharacterName name={characterName[j.character_id]} />
                </td>
                <td className="serif">{ACTIVITY_NAMES[j.activity_id] ?? `#${j.activity_id}`}</td>
                <td>
                  <Name name={typeNames[Number(j.blueprint_type_id)]} id={j.blueprint_type_id} />
                </td>
                <td>
                  {j.product_type_id != null ? (
                    <Name name={typeNames[Number(j.product_type_id)]} id={j.product_type_id} />
                  ) : (
                    '—'
                  )}
                </td>
                <td className={retro.num}>{j.runs}</td>
                <td>{j.status}</td>
                <td>
                  <DateTime value={j.start_date} />
                </td>
                <td>
                  <DateTime value={j.end_date} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p>No industry jobs known at this structure.</p>
      )}
    </>
  )
}

export default StructurePage
