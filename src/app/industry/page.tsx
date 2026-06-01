import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'
import { fetchTypeNames } from '../typeNames'
import { ActiveJobs, type Job } from './activeJobs'

const IndustryPage = async () => {
  const supabase = await createClient()

  const { data, error: authError } = await supabase.auth.getUser()
  if (authError || !data?.user) {
    redirect('/')
  }

  const { data: characters } = await supabase.schema('hangar').from('registration').select('id, name')

  const { data: jobs } = await supabase
    .schema('hangar')
    .from('industry_job')
    .select(
      'job_id, character_id, activity_id, blueprint_type_id, product_type_id, runs, status, start_date, end_date, station_id, facility_id'
    )
    .eq('status', 'active')
    .order('end_date', { ascending: true })

  const sortedCharacters = [...(characters ?? [])].sort((a, b) => a.name.localeCompare(b.name))

  // Map structure (station) ids to their names so the jobs table can link to them.
  const { data: structures } = await supabase.schema('hangar').from('corp_structure').select('structure_id, name')
  const stationNames: Record<string, string> = Object.fromEntries(
    ((structures ?? []) as Array<{ structure_id: number | string; name: string | null }>)
      .filter((s) => s.name != null)
      .map((s) => [String(s.structure_id), s.name as string])
  )

  const jobRows = (jobs ?? []) as Job[]
  const typeNamesPromise = fetchTypeNames(
    jobRows.flatMap((j) => (j.product_type_id != null ? [Number(j.product_type_id)] : []))
  )

  const initialNow = Date.now()

  return (
    <>
      <h1>Industry</h1>
      <ActiveJobs
        jobs={jobRows}
        characters={sortedCharacters}
        initialNow={initialNow}
        typeNamesPromise={typeNamesPromise}
        stationNames={stationNames}
      />
    </>
  )
}
export default IndustryPage
