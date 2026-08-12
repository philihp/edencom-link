// Lazy anon Supabase client for the public-read `sde_*` tables and views, for
// use from the plain-JS extract jobs. src/utils/supabase/sde.ts is the same
// idea for the app, but it imports via `@/` and so can't load under `node
// src/jobs/<job>.js`; the env fallbacks mirror src/buildEsfData.js.
//
// Callers treat a missing client (unset env) as "no name available" and fall
// back to raw ids rather than failing the extract — a ping naming a structure
// id beats no ping at all.
import { createClient } from '@supabase/supabase-js'

let client

export const sdeAnon = () => {
  if (client === undefined) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_KEY
    client = url && key ? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }) : null
  }
  return client
}
