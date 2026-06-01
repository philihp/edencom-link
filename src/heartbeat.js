import { recordHeartbeat } from './supabase.js'

const job = process.env.HEARTBEAT_JOB ?? 'daily'

const ok = await recordHeartbeat(job)
if (!ok) process.exit(1)
