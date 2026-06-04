import { NextRequest } from 'next/server'

// Vercel Cron invokes these routes with `Authorization: Bearer ${CRON_SECRET}`.
// Reject anything else so the public route can't be hand-triggered to spam the queue.
export const authorizeCron = (request: NextRequest): boolean => {
  const secret = process.env.CRON_SECRET
  return !!secret && request.headers.get('authorization') === `Bearer ${secret}`
}
