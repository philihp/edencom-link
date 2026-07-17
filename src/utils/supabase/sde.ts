import { createClient, SupabaseClient } from '@supabase/supabase-js'

// The SDE mirror tables (sde_*) are public-read static data — RLS grants
// SELECT to anon — so one module-level anon client serves every context
// (server components, route handlers, MCP tools, anonymous share pages)
// without cookie or bearer plumbing. Never used for writes.
let client: SupabaseClient | null = null

export const sdeSupabase = (): SupabaseClient => {
  if (client) return client
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_KEY
  if (!url || !key) throw new Error('sde: missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY')
  client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  return client
}
