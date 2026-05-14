import { authenticate, sudoSupabase } from './supabase.js'

const execute = async () => {
  await authenticate()
  const res = await sudoSupabase.from('character_token').select(`id, name`)
  console.log(res)
}

execute()
