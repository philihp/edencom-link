import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_KEY
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY
const supabaseUsername = process.env.SUPABASE_USERNAME
const supabasePassword = process.env.SUPABASE_PASSWORD

export const supabase = createClient(supabaseUrl, supabaseKey)

export const sudoSupabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
})

export const sudoSupabaseAdmin = sudoSupabase.auth.admin

export const authenticate = async () => {
  const { data, error } = await supabase.auth.signInWithPassword({
    email: supabaseUsername,
    password: supabasePassword,
  })
  return error ?? data
}

export const upsertCharacter = async (columns) => {
  const response = await supabase.from('character').upsert(columns, { onConflict: 'owner' }).select()
  return response.data?.[0]?.id
}

export const upsertToken = async (columns) => {
  const response = await supabase
    .from('token')
    .upsert(columns, { onConflict: ['character_id', 'scope'] })
    .select()
  if (response.error) console.error(response.error)
  return response.data?.[0]?.id
}

export const upsertAssets = async (assets) => {
  const response = await supabase
    .from('asset')
    .upsert(assets, { onConflict: ['item_id'] })
    .select()
  return response
}

export const selectCharacters = async (columns, owner) => {
  let query = supabase.from('character').select(columns)
  if (owner !== undefined) query = query.eq('owner', owner)
  const response = await query
  return response?.data?.map((r) => r.id)
}

export const selectToken = async (character_id, scope = []) => {
  const response = await supabase
    .from('token')
    .select('refresh_token, scope')
    .eq('character_id', character_id)
    .contains('scope', [scope].flat())
    .order('expires_at', { ascending: true })
  return response
}
