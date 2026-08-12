import Link from 'next/link'
import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'

import { establishedUser } from '../lib/establishedUser'
import { isChancellor } from '../settings/chancellor/chancellor'
import ImpersonateForm from './impersonateForm'

const DebugPage = async () => {
  const supabase = await createClient()

  const user = await establishedUser(supabase)
  if (!user) {
    redirect('/account/login')
  }

  const { data: settings } = await supabase
    .from('user_settings')
    .select('enabled_scopes, api_token, flags, updated_at')
    .eq('user_id', user.id)
    .maybeSingle()

  const debugInfo = {
    user_id: user.id,
    email: user.email,
    created_at: user.created_at,
    last_sign_in_at: user.last_sign_in_at,
    enabled_scopes: settings?.enabled_scopes ?? [],
    api_token: settings?.api_token ?? null,
    flags: settings?.flags ?? [],
    settings_updated_at: settings?.updated_at ?? null,
  }

  const chancellor = await isChancellor(user.id)

  return (
    <>
      <Link href="/account/settings">&laquo; Back to settings</Link>

      <h1>Debug</h1>

      <pre>{JSON.stringify(debugInfo, null, 2)}</pre>

      {chancellor && (
        <>
          <h2>Impersonate</h2>
          <p>Swaps this session for a real session as another account. Sign back in as yourself to return.</p>
          <ImpersonateForm />
        </>
      )}
    </>
  )
}

export default DebugPage
