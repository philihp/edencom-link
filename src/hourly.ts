import { authenticate, sudoSupabase } from './supabase'

const execute = async () => {
  await authenticate()
  const res = await sudoSupabase.from('character_token').select('id, name')
  console.log(res)
}

execute()
