import Link from 'next/link'
import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'

import { establishedUser } from '../../account/lib/establishedUser'
import { esiScopes } from '@/app/character/scopes'

import Grants from './grants'

type GrantsPageProps = {
  searchParams: Promise<{ from?: string }>
}

const GrantsPage = async ({ searchParams }: GrantsPageProps) => {
  const supabase = await createClient()

  const user = await establishedUser(supabase)
  if (!user) {
    redirect('/account/login')
  }

  const { from } = await searchParams
  const dest = from === 'characters' ? 'characters' : 'settings'

  // Read the saved selection directly so nothing optional is pre-checked by
  // default — a brand new player opts in to what they want to share.
  const { data: settings } = await supabase
    .from('user_settings')
    .select('enabled_scopes')
    .eq('user_id', user.id)
    .maybeSingle()
  const enabledScopes: string[] = settings?.enabled_scopes ?? []

  return (
    <>
      {dest === 'characters' ? (
        <Link href="/account/registrations">&laquo; Back to registrations</Link>
      ) : (
        <Link href="/account/settings">&laquo; Back to settings</Link>
      )}

      <h1>ESI Access</h1>

      <Grants scopes={esiScopes} enabled={enabledScopes} from={dest} />
    </>
  )
}

export default GrantsPage
