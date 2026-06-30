import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'
import { indexesFlag } from '@/flags'

const IndexesPage = async () => {
  const supabase = await createClient()

  const { data, error: authError } = await supabase.auth.getUser()
  if (authError || !data?.user) {
    redirect('/')
  }

  if (!(await indexesFlag())) {
    redirect('/')
  }

  return (
    <>
      <h1>Indexes</h1>
      <p>Coming soon.</p>
    </>
  )
}
export default IndexesPage
