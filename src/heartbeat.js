import { sudoSupabase } from './supabase.js'

const job = process.env.HEARTBEAT_JOB ?? 'daily'

const { error } = await sudoSupabase.schema('hangar').from('heartbeat').insert({ job })

if (error) {
  console.error(error)
  process.exit(1)
}

console.log(`heartbeat recorded: ${job}`)
