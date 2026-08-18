import { createClient } from '@supabase/supabase-js'

import { timedSupabaseFetch } from './timedFetch'

// Service-role Supabase client for server-only code paths that can't rely on the
// caller's session — notably the /api/character/assets IMPORTDATA endpoint, which is
// authenticated by an opaque api_token rather than a Supabase auth cookie. It
// bypasses RLS, so callers MUST scope every query to the resolved user_id
// themselves. Mirrors `sudoSupabase` in src/supabase.js but uses the Next public
// URL var (same project) alongside the server-only service key.
export const createServiceClient = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!, {
    global: { fetch: timedSupabaseFetch('db') },
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
