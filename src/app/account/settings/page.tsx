import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'
import { esiScopes } from '@/app/character/scopes'
import { getEnabledScopes } from '@/app/character/userScopes'

import ChangePassword from './changePassword'
import { LogoffButton } from './logoffButton'
import ScopeSettings from './scopeSettings'

const SettingsPage = async () => {
  const supabase = await createClient()

  const { data, error } = await supabase.auth.getUser()
  if (error || !data?.user) {
    redirect('/account/login')
  }

  const enabledScopes = await getEnabledScopes(supabase, data.user.id)

  return (
    <>
      <h1>Settings</h1>

      <ChangePassword />

      <ScopeSettings scopes={esiScopes} enabled={enabledScopes} />

      <h2>Logoff</h2>
      <LogoffButton />
    </>
  )
}

export default SettingsPage
