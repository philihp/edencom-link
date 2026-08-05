import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'

import { decodePendingIdentity, PENDING_COOKIE } from '../oidc'
import CompleteForm from './completeForm'

// The landing step after a first-time GICE sign-in: the OAuth flow verified
// who they are (the signed pending cookie carries it), but registration stays
// invite-only, so an unused invite code is still required to mint the account.
const CompletePage = async () => {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (user) redirect('/')

  const cookieStore = await cookies()
  const identity = decodePendingIdentity(cookieStore.get(PENDING_COOKIE)?.value)
  if (!identity) redirect('/account/login')

  return <CompleteForm name={identity.name} />
}

export default CompletePage
