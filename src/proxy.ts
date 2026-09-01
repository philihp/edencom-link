import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

import { sessionCookieOptions } from '@/utils/supabase/cookieOptions'

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({
    request: { headers: request.headers },
  })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) {
    console.error(`proxy: missing supabase env (url=${!!url} key=${!!key})`)
    return response
  }

  try {
    const supabase = createServerClient(url, key, {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          response = NextResponse.next({
            request: { headers: request.headers },
          })
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, sessionCookieOptions(options))
          )
        },
      },
    })

    // Called for its side effect, not its answer: @supabase/ssr refreshes an
    // access token that is at or near expiry and writes the new cookies back
    // through setAll() above. That refresh is what keeps a session alive across
    // requests, so this call cannot simply be dropped.
    //
    // getClaims() rather than getUser() because getUser() asks the Auth server
    // on *every* request — a single-region round trip in front of every page,
    // and the page then paid a second one in establishedUser(). getClaims()
    // still goes through getSession() first (auth-js GoTrueClient.getClaims →
    // getSession → __loadSession, which refreshes inside EXPIRY_MARGIN_MS), so
    // the refresh behaviour is unchanged; what goes away is the per-request
    // confirmation call, replaced by local verification against the project's
    // JWKS. See the note in account/lib/establishedUser.ts for the liveness
    // tradeoff that buys, and why this project can verify locally at all.
    await supabase.auth.getClaims()
  } catch (err) {
    console.error('proxy: supabase auth threw', err)
  }

  return response
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
}
