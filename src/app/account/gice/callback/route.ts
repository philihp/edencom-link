// /account/gice/callback — finish the GICE authorization code flow.
//
// Three outcomes, decided by who arrives:
// - a signed-in user links GICE to their account (back to settings),
// - a signed-out user whose GICE account is already linked signs in,
// - anyone else proceeds to /account/gice/complete, which finishes the
//   registration (an invite code is optional there — see
//   docs/open-registration.md). "Anyone else" includes a caller holding an
//   anonymous session: that is an account still mid-flow, not a member linking
//   GICE, and the completion step converts it in place rather than linking a
//   drive-by account nobody can sign into.

import { cookies } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'

import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'

import { establishedUser } from '../../lib/establishedUser'
import { mintSession } from '../../lib/mintSession'
import {
  encodePendingIdentity,
  exchangeGiceCode,
  giceConfig,
  giceUserinfo,
  OAUTH_COOKIE_PATH,
  PENDING_COOKIE,
  STATE_COOKIE,
} from '../oidc'

const redirectTo = (request: NextRequest, pathname: string, search = '') => {
  const url = request.nextUrl.clone()
  url.pathname = pathname
  url.search = search
  return NextResponse.redirect(url)
}

export const GET = async (request: NextRequest) => {
  const { searchParams } = new URL(request.url)
  const code = searchParams.get('code')
  const state = searchParams.get('state')

  const cookieStore = await cookies()
  const stateCookie = cookieStore.get(STATE_COOKIE)?.value
  cookieStore.delete({ name: STATE_COOKIE, path: OAUTH_COOKIE_PATH })

  const [expectedState, verifier] = (stateCookie ?? '').split(':')
  if (!code || !state || !expectedState || !verifier || state !== expectedState) {
    console.warn('/account/gice/callback: state mismatch or missing code')
    return redirectTo(request, '/error')
  }

  let identity
  try {
    const config = await giceConfig()
    const accessToken = await exchangeGiceCode(config, code, verifier)
    identity = await giceUserinfo(config, accessToken)
  } catch (e) {
    console.warn(`/account/gice/callback: ${(e as Error)?.message}`)
    return redirectTo(request, '/error')
  }

  const service = createServiceClient()
  const { data: existing } = await service
    .from('gice_account')
    .select('user_id')
    .eq('gice_id', identity.giceId)
    .maybeSingle()

  const supabase = await createClient()
  // The *member*, not merely a session: an anonymous account mid-flow has
  // nothing to link GICE to yet, and would be bounced straight back out of
  // /account/settings. It goes down the completion path below instead.
  const user = await establishedUser(supabase)

  if (user) {
    // Link flow: attach this GICE identity to the signed-in account.
    if (existing && existing.user_id !== user.id) {
      return redirectTo(request, '/account/settings', '?gice=conflict')
    }
    if (!existing) {
      const { error } = await service.from('gice_account').insert({
        gice_id: identity.giceId,
        user_id: user.id,
        name: identity.name,
        primary_group: identity.primaryGroup,
      })
      if (error) {
        console.warn(`/account/gice/callback: link insert failed: ${error.message}`)
        return redirectTo(request, '/error')
      }
    }
    return redirectTo(request, '/account/settings')
  }

  if (existing) {
    // Sign-in flow: freshen the display fields, then mint a session.
    await service
      .from('gice_account')
      .update({ name: identity.name, primary_group: identity.primaryGroup, updated_at: new Date().toISOString() })
      .eq('gice_id', identity.giceId)
    const error = await mintSession(existing.user_id)
    if (error) {
      console.warn(`/account/gice/callback: sign-in failed: ${error}`)
      return redirectTo(request, '/error')
    }
    return redirectTo(request, '/')
  }

  // Registration flow: carry the verified identity to the invite code step.
  cookieStore.set(PENDING_COOKIE, encodePendingIdentity(identity), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 600,
    path: OAUTH_COOKIE_PATH,
  })
  return redirectTo(request, '/account/gice/complete')
}
