import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.SUPABASE_URL!
const supabaseKey = process.env.SUPABASE_KEY!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY!
const supabaseUsername = process.env.SUPABASE_USERNAME!
const supabasePassword = process.env.SUPABASE_PASSWORD!

export const supabase: SupabaseClient = createClient(supabaseUrl, supabaseKey)

export const sudoSupabase: SupabaseClient = createClient(supabaseUrl, supabaseServiceKey, {
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

export type CharacterColumns = {
  user_id?: string
  owner: string
  name: string
}

export const upsertCharacter = async (columns: CharacterColumns) => {
  const response = await supabase.from('character').upsert(columns, { onConflict: 'owner' }).select()
  return response.data?.[0]?.id as string | undefined
}

export type TokenColumns = {
  user_id?: string
  character_id: string
  access_token: string
  refresh_token: string
  issued_at: string
  expires_at: string
  scope: string[]
}

export const upsertToken = async (columns: TokenColumns) => {
  const response = await supabase
    .from('token')
    .upsert(columns, { onConflict: 'character_id, scope' })
    .select()
  if (response.error) console.error(response.error)
  return response.data?.[0]?.id as string | undefined
}

export const upsertAssets = async (assets: Record<string, unknown>[]) => {
  return await supabase.from('asset').upsert(assets, { onConflict: 'item_id' }).select()
}

export const selectCharacters = async (columns: string, owner?: string): Promise<string[]> => {
  let query = supabase.from('character').select(columns)
  if (owner !== undefined) query = query.eq('owner', owner)
  const response = await query
  return ((response?.data as { id: string }[] | null) ?? []).map((r) => r.id)
}

export const selectToken = async (character_id: string, scope: string | string[] = []) => {
  return await supabase
    .from('token')
    .select('refresh_token, scope')
    .eq('character_id', character_id)
    .contains('scope', [scope].flat())
    .order('expires_at', { ascending: true })
}
