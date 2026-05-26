import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'

const IndustryPage = async () => {
  const supabase = await createClient()

  const { data, error } = await supabase.auth.getUser()
  if (error || !data?.user) {
    redirect('/')
  }

  return <h1>Industry</h1>
}
export default IndustryPage
