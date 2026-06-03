import type { NextRequest } from 'next/server'

import { recordHeartbeat } from '@/supabase.js'
import { verifyCronSecret } from '../auth'

export const maxDuration = 10

export async function GET(request: NextRequest) {
  const authError = verifyCronSecret(request)
  if (authError) return authError

  const job = new URL(request.url).searchParams.get('job') ?? 'daily'
  await recordHeartbeat(job)
  return Response.json({ success: true })
}
