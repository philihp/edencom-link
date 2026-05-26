import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'

const StructuresPage = async () => {
  const supabase = await createClient()

  const { data, error } = await supabase.auth.getUser()
  if (error || !data?.user) {
    redirect('/')
  }

  return <h1>Structures</h1>
}
export default StructuresPage
