import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'

import { establishedUser } from '../../lib/establishedUser'

import { decodePendingIdentity, PENDING_COOKIE } from '../oidc'
import CompleteForm from './completeForm'

// The landing step after a first-time GICE sign-in: the OAuth flow verified who
// they are (the signed pending cookie carries it) and this turns that into an
// account. Nothing else is asked of them — an invite code is optional here, and
// only records who referred them (docs/open-registration.md).
//
// A caller holding an anonymous session belongs here too, not on the link path:
// establishedUser() sends only members away, so the account they are already
// carrying is the one the completion step converts.
const CompletePage = async () => {
  const supabase = await createClient()
  const user = await establishedUser(supabase)
  if (user) redirect('/')

  const cookieStore = await cookies()
  const identity = decodePendingIdentity(cookieStore.get(PENDING_COOKIE)?.value)
  if (!identity) redirect('/account/login')

  return <CompleteForm name={identity.name} />
}

export default CompletePage
