import { recordHeartbeat } from './supabase.js'

// Run as its own step from the scheduled workflows, once before the job
// (HEARTBEAT_PHASE=start) and once after (HEARTBEAT_PHASE=end), keeping the
// heartbeat bookkeeping out of the job scripts themselves.
const job = process.env.HEARTBEAT_JOB ?? 'daily'
const phase = process.env.HEARTBEAT_PHASE ?? 'end'

const ok = await recordHeartbeat(job, phase)
if (!ok) process.exit(1)
