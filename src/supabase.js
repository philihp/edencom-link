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

// Record that a scheduled job ran by inserting a row into hangar.heartbeat. The
// UI reads the latest row per job to show when each extract last completed.
// Returns true on success, false (after logging) on failure so callers can
// decide whether a failed heartbeat should fail the whole job.
export const recordHeartbeat = async (job) => {
  const { error } = await sudoSupabase.schema('hangar').from('heartbeat').insert({ job })
  if (error) {
    console.error(`[heartbeat] failed to record "${job}":`, error)
    return false
  }
  console.log(`[heartbeat] recorded: ${job}`)
  return true
}

export const authenticate = async () => {
  const { data, error } = await supabase.auth.signInWithPassword({
    email: supabaseUsername,
    password: supabasePassword,
  })
  return error ?? data
}

export const upsertCharacter = async (columns) => {
  const response = await supabase
    .schema('hangar')
    .from('registration')
    .upsert(columns, { onConflict: 'user_id, owner' })
    .select()
  return response.data?.[0]?.id
}

export const upsertToken = async (columns) => {
  const response = await supabase
    .schema('hangar')
    .from('token')
    .upsert(columns, { onConflict: ['character_id'] })
    .select()
  if (response.error) console.error(response.error)
  return response.data?.[0]?.id
}

export const upsertAssets = async (assets) => {
  const response = await supabase
    .schema('hangar')
    .from('asset')
    .upsert(assets, { onConflict: ['item_id'] })
    .select()
  return response
}

export const selectCharacters = async (columns, owner) => {
  let query = supabase.schema('hangar').from('registration').select(columns)
  if (owner !== undefined) query = query.eq('owner', owner)
  const response = await query
  return response?.data?.map((r) => r.id)
}

export const selectToken = async (character_id, scope = []) => {
  const response = await supabase
    .schema('hangar')
    .from('token')
    .select('refresh_token, scope')
    .eq('character_id', character_id)
    .contains('scope', [scope].flat())
    .order('expires_at', { ascending: true })
  return response
}
