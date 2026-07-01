import Link from 'next/link'
import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'

const DebugPage = async () => {
  const supabase = await createClient()

  const { data, error } = await supabase.auth.getUser()
  if (error || !data?.user) {
    redirect('/account/login')
  }

  const { data: settings } = await supabase
    .from('user_settings')
    .select('enabled_scopes, api_token, flags, updated_at')
    .eq('user_id', data.user.id)
    .maybeSingle()

  const debugInfo = {
    user_id: data.user.id,
    email: data.user.email,
    created_at: data.user.created_at,
    last_sign_in_at: data.user.last_sign_in_at,
    enabled_scopes: settings?.enabled_scopes ?? [],
    api_token: settings?.api_token ?? null,
    flags: settings?.flags ?? [],
    settings_updated_at: settings?.updated_at ?? null,
  }

  return (
    <>
      <Link href="/account/settings">&laquo; Back to settings</Link>

      <h1>Debug</h1>

      <pre>{JSON.stringify(debugInfo, null, 2)}</pre>
    </>
  )
}

export default DebugPage
