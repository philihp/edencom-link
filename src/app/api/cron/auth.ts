import type { NextRequest } from 'next/server'

export function verifyCronSecret(request: NextRequest): Response | null {
  const secret = process.env.CRON_SECRET
  if (!secret) return new Response('CRON_SECRET not configured', { status: 500 })
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return new Response('Unauthorized', { status: 401 })
  }
  return null
}
