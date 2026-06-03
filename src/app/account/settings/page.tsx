import Link from 'next/link'
import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'

import ChangePassword from './changePassword'
import { LogoffButton } from './logoffButton'

const SettingsPage = async () => {
  const supabase = await createClient()

  const { data, error } = await supabase.auth.getUser()
  if (error || !data?.user) {
    redirect('/account/login')
  }

  return (
    <>
      <h1>Settings</h1>

      <ChangePassword />

      <h2>ESI Access</h2>
      <p>Choose which data we may read from EVE Online when you add a character.</p>
      <Link href="/settings/grants">Manage ESI access</Link>

      <h2>Logoff</h2>
      <LogoffButton />
    </>
  )
}

export default SettingsPage
