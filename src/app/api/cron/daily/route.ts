import type { NextRequest } from 'next/server'

import { runDaily } from '@/daily.js'
import { recordHeartbeat } from '@/supabase.js'
import { verifyCronSecret } from '../auth'

export const maxDuration = 300

export async function GET(request: NextRequest) {
  const authError = verifyCronSecret(request)
  if (authError) return authError

  await recordHeartbeat('daily', 'start')
  try {
    await runDaily()
    await recordHeartbeat('daily', 'end')
    return Response.json({ success: true })
  } catch (e) {
    await recordHeartbeat('daily', 'end')
    console.error('[cron/daily] failed:', e)
    return Response.json({ success: false, error: String(e) }, { status: 500 })
  }
}
