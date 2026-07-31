import { redirect } from 'next/navigation'
import { filter } from 'ramda'

import { createClient } from '@/utils/supabase/server'
import { fetchOwners } from '../owners'
import { fetchStationNames } from '../stationNames'
import { fetchTypeNames } from '../typeNames'
import { ActiveJobs, type Job } from './activeJobs'

type JobColumns = {
  job_id: number | string
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

const JOB_COLUMNS =
  'job_id, activity_id, blueprint_type_id, product_type_id, runs, status, start_date, end_date, station_id, facility_id'

const IndustryPage = async () => {
  const supabase = await createClient()

  const { data, error: authError } = await supabase.auth.getUser()
  if (authError || !data?.user) {
    redirect('/')
  }

  const [{ data: characterJobs }, { data: corpJobs }, owners] = await Promise.all([
    supabase
      .from('character_industry_job')
      .select(`${JOB_COLUMNS}, registration_id`)
      .eq('status', 'active')
      .order('end_date', { ascending: true }),
    supabase
      .from('corp_industry_job')
      .select(`${JOB_COLUMNS}, corporation_id`)
      .eq('status', 'active')
      .order('end_date', { ascending: true }),
    fetchOwners(),
  ])

  // Union both sources under a single owner id per job. A corp job installed by
  // one of our own characters shows up in both extracts under the same job_id;
  // the corp row wins so the Owner column names who the job actually belongs to.
  const corpRows: Job[] = ((corpJobs ?? []) as (JobColumns & { corporation_id: number | string })[]).map(
    ({ corporation_id, ...j }) => ({ ...j, owner_id: String(corporation_id) })
  )
  const corpJobIds = new Set(corpRows.map((j) => String(j.job_id)))
  const characterRows: Job[] = ((characterJobs ?? []) as (JobColumns & { registration_id: string })[])
    .filter((j) => !corpJobIds.has(String(j.job_id)))
    .map(({ registration_id, ...j }) => ({ ...j, owner_id: registration_id }))
  const jobRows: Job[] = [...characterRows, ...corpRows].sort(
    (a, b) => new Date(a.end_date).getTime() - new Date(b.end_date).getTime()
  )

  // Map job station/facility ids to their names so the jobs table can link to
  // them. Structures come from two caches — our own corp's (corp_structure,
  // which wins on overlap) and foreign player structures resolved by ESI
  // (universe_structure) — while NPC stations resolve via the universe_name
  // cache. Mirrors the location-name resolution on the assets page.
  const jobLocationIds = filter(
    Number.isFinite,
    jobRows.map((j) => Number(j.station_id ?? j.facility_id))
  )
  const [{ data: corpStructures }, { data: playerStructures }, npcStationNames] = await Promise.all([
    supabase.from('corp_structure').select('structure_id, name'),
    jobLocationIds.length
      ? supabase.from('universe_structure').select('structure_id, name').in('structure_id', jobLocationIds)
      : Promise.resolve({ data: [] }),
    fetchStationNames(jobLocationIds),
  ])
  const structureNames: Record<string, string> = Object.fromEntries(
    [
      ...((playerStructures ?? []) as Array<{ structure_id: number | string; name: string | null }>),
      ...((corpStructures ?? []) as Array<{ structure_id: number | string; name: string | null }>),
    ]
      .filter((s) => s.name != null)
      .map((s) => [String(s.structure_id), s.name as string])
  )
  const stationNames: Record<string, string> = { ...npcStationNames, ...structureNames }

  const typeNamesPromise = fetchTypeNames(
    jobRows.flatMap((j) => (j.product_type_id != null ? [Number(j.product_type_id)] : []))
  )

  const initialNow = Date.now()

  return (
    <>
      <h1>Industry</h1>
      <ActiveJobs
        jobs={jobRows}
        owners={owners}
        initialNow={initialNow}
        typeNamesPromise={typeNamesPromise}
        stationNames={stationNames}
      />
    </>
  )
}
export default IndustryPage
