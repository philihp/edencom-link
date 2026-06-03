import type { NextRequest } from 'next/server'

import { runStructures } from '@/structures.js'
import { recordHeartbeat } from '@/supabase.js'
import { verifyCronSecret } from '../auth'

export const maxDuration = 300

export async function GET(request: NextRequest) {
  const authError = verifyCronSecret(request)
  if (authError) return authError

  await recordHeartbeat('structures', 'start')
  try {
    await runStructures()
    await recordHeartbeat('structures', 'end')
    return Response.json({ success: true })
  } catch (e) {
    await recordHeartbeat('structures', 'end')
    console.error('[cron/structures] failed:', e)
    return Response.json({ success: false, error: String(e) }, { status: 500 })
  }
}
