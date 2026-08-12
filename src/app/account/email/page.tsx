import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'

import { establishedUser } from '../lib/establishedUser'

import { isSsoPlaceholderEmail } from '../lib/ssoEmail'
import EmailForm from './emailForm'

// Add (or change) the account's email address. The main audience is accounts
// created through an SSO provider (GICE, and Discord soon), whose address is
// an undeliverable placeholder until they set a real one here — which also
// unlocks email/password login and password reset as a fallback.
const EmailPage = async () => {
  const supabase = await createClient()
  const user = await establishedUser(supabase)
  if (!user) redirect('/account/login?next=/account/email')

  const placeholder = isSsoPlaceholderEmail(user.email)
  return <EmailForm currentEmail={placeholder ? null : (user.email ?? null)} />
}

export default EmailPage
