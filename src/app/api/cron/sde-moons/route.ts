import { NextRequest, NextResponse } from 'next/server'

import { requireCronSecret } from '@/utils/cron'

// Weekly sde_map_moons trigger (see vercel.json). Shaped exactly like the
// nightly /api/cron/sde-mirror route: it neither runs the job inline nor fans
// out queue messages — a 344,457-row ingest dwarfs one 60s invocation — it
// starts the sde-moons Vercel Workflow (src/workflows/sdeMoons.ts) and returns.
// Fire-and-forget: the workflow owns retries and its run/step status shows under
// Observability → Workflows; the heartbeat pair is recorded by the workflow's
// first and last steps. There is no skip decision and so no force flag — the
// point of the weekly schedule is that the run can be unconditional.
export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  const { start } = await import('workflow/api')
  const { sdeMoonsWorkflow } = await import('@/workflows/sdeMoons')
  const run = await start(sdeMoonsWorkflow, [])
  console.log(`[cron/sde-moons] started workflow run=${run.runId}`)

  return NextResponse.json({ ok: true, runId: run.runId })
}
