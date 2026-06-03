import type { NextRequest } from 'next/server'

import { runAssets } from '@/assets.js'
import { recordHeartbeat } from '@/supabase.js'
import { verifyCronSecret } from '../auth'

export const maxDuration = 60

export async function GET(request: NextRequest) {
  const authError = verifyCronSecret(request)
  if (authError) return authError

  await recordHeartbeat('assets', 'start')
  try {
    await runAssets()
    await recordHeartbeat('assets', 'end')
    return Response.json({ success: true })
  } catch (e) {
    await recordHeartbeat('assets', 'end')
    console.error('[cron/assets] failed:', e)
    return Response.json({ success: false, error: String(e) }, { status: 500 })
  }
}
