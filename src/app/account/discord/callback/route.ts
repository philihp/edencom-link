// /account/discord/callback — the end of Supabase's Discord round trip.
//
// Both entry paths land here: signInWithOAuth (no session yet) and
// linkIdentity (converting the account the caller was already holding). Either
// way the code is exchanged the same way, on the SSR client, so the session
// cookies are written before the redirect.
//
// This is also where a returning member whose browser lost its cookies is
// caught: they arrive holding a fresh anonymous session, so the start went down
// the link path, and Supabase refuses because that Discord identity is already
// attached to their real account. Nothing is broken — they just need to arrive
// without the stale session, which is what the message on /account/login says.
import { NextRequest, NextResponse } from 'next/server'

import { createClient } from '@/utils/supabase/server'

const back = (request: NextRequest, pathname: string, search = '') => {
  const url = request.nextUrl.clone()
  url.pathname = pathname
  url.search = search
  return NextResponse.redirect(url)
}

const sanitizeNext = (next: string | null): string => (next?.startsWith('/') && !next.startsWith('//') ? next : '/')

export const GET = async (request: NextRequest) => {
  const { searchParams } = new URL(request.url)
  const next = sanitizeNext(searchParams.get('next'))

  // Discord (or Supabase) can refuse before any code is issued — a cancelled
  // consent screen is the ordinary case.
  const providerError = searchParams.get('error_description') ?? searchParams.get('error')
  if (providerError) {
    console.warn(`/account/discord/callback: ${providerError}`)
    return back(request, '/account/login', '?discord=failed')
  }

  const code = searchParams.get('code')
  if (!code) return back(request, '/account/login', '?discord=failed')

  const supabase = await createClient()
  const { error } = await supabase.auth.exchangeCodeForSession(code)
  if (error) {
    // The common cause is an identity already attached to another account,
    // which is a sign-in that took the linking path, not a real failure of
    // theirs — so say what to do rather than dumping them on /error.
    console.warn(`/account/discord/callback: exchange failed: ${error.message}`)
    return back(request, '/account/login', '?discord=linked-elsewhere')
  }

  return back(request, next)
}
