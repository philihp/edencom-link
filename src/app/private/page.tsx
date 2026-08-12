import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'

import { establishedUser } from '../account/lib/establishedUser'

export default async function PrivatePage() {
  const supabase = await createClient()

  const user = await establishedUser(supabase)
  if (!user) {
    redirect('/')
  }

  return <p>Hello {user.email}</p>
}
