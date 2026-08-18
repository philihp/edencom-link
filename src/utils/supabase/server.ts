import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

import { sessionCookieOptions } from './cookieOptions'
import { timedSupabaseFetch } from './timedFetch'

export const createClient = async () => {
  const cookieStore = await cookies()
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    // Every query this client makes becomes a Server-Timing span when the
    // caller is collecting them (src/serverTiming.ts); a no-op otherwise.
    global: { fetch: timedSupabaseFetch('db') },
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, sessionCookieOptions(options))
          )
        } catch {
          // The setAll method was called from a Server Component.
          // This can be ignored if src/proxy.ts is refreshing user sessions.
        }
      },
    },
  })
}
