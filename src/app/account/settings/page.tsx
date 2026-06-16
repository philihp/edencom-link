import Link from 'next/link'
import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'

import ApiToken from './apiToken'
import ChangePassword from './changePassword'
import { LogoffButton } from './logoffButton'

const SettingsPage = async () => {
  const supabase = await createClient()

  const { data, error } = await supabase.auth.getUser()
  if (error || !data?.user) {
    redirect('/account/login')
  }

  const { data: settings } = await supabase.from('user_settings').select('api_token, is_chancellor').maybeSingle()

  return (
    <>
      <h1>Settings</h1>

      <ChangePassword />

      <h2>ESI Access</h2>
      <p>Choose which data we may read from EVE Online when you add a character.</p>
      <Link href="/settings/grants">Manage ESI access</Link>

      <h2>Invite codes</h2>
      <p>Edencom Link is invite-only. See the codes you can give out and when you earn more.</p>
      <Link href="/account/invite">Manage invite codes</Link>

      <ApiToken initialToken={settings?.api_token ?? null} />

      {settings?.is_chancellor && (
        <>
          <h2>Chancellor</h2>
          <p>You have Chancellor powers. Manage who else is a Chancellor and mint invite codes anytime.</p>
          <Link href="/account/chancellor">Manage chancellors</Link>
        </>
      )}

      <h2>Logoff</h2>
      <LogoffButton />
    </>
  )
}

export default SettingsPage
