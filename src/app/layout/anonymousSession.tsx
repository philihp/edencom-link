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
// A client component rather than middleware: the repo runs no middleware, the
// Turnstile challenge needs a browser, and mounting it in the root layout keeps
// the machine traffic — /xrpc, /api/*, /esf, /sheets — from minting users, since
// none of those render HTML.
//
// Nothing renders; the component exists for its effect.

// The Turnstile sitekey is public by design. Unset (local dev, preview
// deployments without the key), the challenge is skipped — Supabase only
// demands a token when captcha protection is switched on for the project.
const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY
const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'

type Turnstile = {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string
      size?: string
      callback: (token: string) => void
      'error-callback'?: () => void
    }
  ) => string
  remove: (widgetId: string) => void
}

declare global {
  interface Window {
    turnstile?: Turnstile
  }
}

// One bootstrap per page load, however many times React remounts the effect
// (StrictMode double-invokes it in development).
let bootstrapped = false

const loadTurnstile = (): Promise<Turnstile | null> =>
  new Promise((resolve) => {
    if (window.turnstile) return resolve(window.turnstile)
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${TURNSTILE_SRC}"]`)
    const script = existing ?? document.createElement('script')
    script.addEventListener('load', () => resolve(window.turnstile ?? null))
    script.addEventListener('error', () => resolve(null))
    if (!existing) {
      script.src = TURNSTILE_SRC
      script.async = true
      document.head.appendChild(script)
    }
  })

// An invisible widget solves itself as soon as it renders, so this is just
// "give me a token, or nothing if the challenge can't run".
const captchaToken = async (): Promise<string | undefined> => {
  if (!SITE_KEY) return undefined
  const turnstile = await loadTurnstile()
  if (!turnstile) return undefined

  const container = document.createElement('div')
  document.body.appendChild(container)
  const token = await new Promise<string | undefined>((resolve) => {
    try {
      turnstile.render(container, {
        sitekey: SITE_KEY,
        size: 'invisible',
        callback: (value) => resolve(value),
        'error-callback': () => resolve(undefined),
      })
    } catch {
      resolve(undefined)
    }
  })
  container.remove()
  return token
}

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

      const { error } = await supabase.auth.signInAnonymously({
        options: { captchaToken: await captchaToken() },
      })
      if (error) {
        // Anonymous sign-ins disabled, captcha rejected, rate limited: the site
        // still works signed-out, so this is a log, not an error state.
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
