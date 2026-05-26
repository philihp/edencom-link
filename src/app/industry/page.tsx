import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'
import { ActiveJobs, type Job } from './activeJobs'

const IndustryPage = async () => {
  const supabase = await createClient()

  const { data, error: authError } = await supabase.auth.getUser()
  if (authError || !data?.user) {
    redirect('/')
  }

  const { data: characters } = await supabase.schema('hangar').from('character').select('id, name')

  const { data: jobs } = await supabase
    .schema('hangar')
    .from('industry_job')
    .select(
      'job_id, character_id, activity_id, blueprint_type_id, product_type_id, runs, status, start_date, end_date',
    )
    .eq('status', 'active')
    .order('end_date', { ascending: true })

  const sortedCharacters = [...(characters ?? [])].sort((a, b) => a.name.localeCompare(b.name))

  // eslint-disable-next-line react-hooks/purity
  const initialNow = Date.now()

  return (
    <>
      <h1>Industry</h1>
      <ActiveJobs jobs={(jobs ?? []) as Job[]} characters={sortedCharacters} initialNow={initialNow} />
    </>
  )
}
export default IndustryPage
