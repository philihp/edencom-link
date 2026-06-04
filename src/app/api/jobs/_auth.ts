import { NextRequest } from 'next/server'

// These routes enqueue a job's work to the Vercel queue on demand (manual trigger
// or app-driven) — scheduling itself stays with GitHub Actions. Require a shared
// secret as `Authorization: Bearer ${JOB_TRIGGER_SECRET}` so the public route can't
// be hand-triggered to spam the queue.
export const authorizeJobTrigger = (request: NextRequest): boolean => {
  const secret = process.env.JOB_TRIGGER_SECRET
  return !!secret && request.headers.get('authorization') === `Bearer ${secret}`
}
