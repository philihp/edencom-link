import type { NextRequest } from 'next/server'

import { runHourly } from '@/hourly.js'
import { recordHeartbeat } from '@/supabase.js'
import { verifyCronSecret } from '../auth'

export const maxDuration = 60

export async function GET(request: NextRequest) {
  const authError = verifyCronSecret(request)
  if (authError) return authError

  await recordHeartbeat('hourly', 'start')
  try {
    await runHourly()
    await recordHeartbeat('hourly', 'end')
    return Response.json({ success: true })
  } catch (e) {
    await recordHeartbeat('hourly', 'end')
    console.error('[cron/hourly] failed:', e)
    return Response.json({ success: false, error: String(e) }, { status: 500 })
  }
}
