import { createClient } from '@supabase/supabase-js'

// Supabase client authenticated by an OAuth 2.1 access token (issued by
// Supabase Auth acting as the authorization server — see /api/mcp). The token
// rides along as the Authorization header on every PostgREST call, so RLS
// applies exactly as it would for the same user's cookie session. No session
// persistence: each MCP tool call is stateless and builds a fresh client.
export const createBearerClient = (accessToken: string) =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
