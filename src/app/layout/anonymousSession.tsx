'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

import { createClient } from '@/utils/supabase/client'

// Every visitor gets a Supabase account the moment they land, before they have
// chosen how to identify themselves — the anonymous user id is the account from
// then on, so an invite code, an EVE character, an email, a Discord or a GICE
// identity can all be affixed to it later, in any order
// (docs/open-registration.md).
//
// A client component rather than middleware: the repo runs no middleware, and
// mounting it in the root layout keeps the machine traffic — /xrpc, /api/*,
// /esf, /sheets — from minting users, since none of those render HTML.
//
// Nothing renders; the component exists for its effect.

// One bootstrap per page load, however many times React remounts the effect
// (StrictMode double-invokes it in development).
let bootstrapped = false

const AnonymousSession = () => {
  const router = useRouter()

  useEffect(() => {
    if (bootstrapped) return
    bootstrapped = true

    const bootstrap = async () => {
      const supabase = createClient()
      // getSession reads the cookie the server already saw — no round trip, and
      // no user minted for anyone who is signed in (anonymously or otherwise).
      const {
        data: { session },
      } = await supabase.auth.getSession()
      if (session) return

      const { error } = await supabase.auth.signInAnonymously()
      if (error) {
        // Anonymous sign-ins disabled, rate limited: the site still works
        // signed-out, so this is a log, not an error state.
        console.warn(`[anonymous-session] ${error.message}`)
        bootstrapped = false
        return
      }
      // The server rendered this page without the session cookie; refresh so the
      // server components see it (the register page's invite affixing needs it).
      router.refresh()
    }

    void bootstrap()
  }, [router])

  return null
}

export default AnonymousSession
