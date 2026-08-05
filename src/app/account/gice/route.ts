// /account/gice — start the GICE (Goonfleet SSO) authorization code flow.
// Works signed-out (log in / register) and signed-in (link GICE to the
// current account); the callback tells the cases apart.

import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'

import { giceAuthorizeUrl, giceConfig, newOauthState, OAUTH_COOKIE_PATH, STATE_COOKIE } from './oidc'

export const GET = async () => {
  if (!process.env.GICE_CLIENT_ID || !process.env.GICE_SECRET_KEY || !process.env.GICE_CALLBACK_URL) {
    return new NextResponse('GICE login is not configured on this deployment.', { status: 503 })
  }

  const config = await giceConfig()
  const { state, verifier } = newOauthState()

  const cookieStore = await cookies()
  cookieStore.set(STATE_COOKIE, `${state}:${verifier}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 600,
    path: OAUTH_COOKIE_PATH,
  })

  return NextResponse.redirect(giceAuthorizeUrl(config, state, verifier))
}
