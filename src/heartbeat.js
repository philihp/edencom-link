import { recordHeartbeat } from './supabase.js'

// Run as its own step from the scheduled workflows, once before the job
// (`npm run heartbeat -- <job> start`) and once after (`... <job> end`),
// keeping the heartbeat bookkeeping out of the job scripts themselves.
const job = process.argv[2] ?? 'heartbeat'
const phase = process.argv[3] ?? 'end'

const ok = await recordHeartbeat(job, phase)
if (!ok) process.exit(1)
