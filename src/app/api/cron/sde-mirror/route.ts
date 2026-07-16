import { NextRequest, NextResponse } from 'next/server'

import { requireCronSecret } from '@/utils/cron'

// Nightly SDE mirror trigger (12:21 UTC, see vercel.json). Unlike the other
// cron routes this neither runs the job inline nor fans out queue messages —
// a full SDE ingest dwarfs one 60s invocation — it starts the sde-mirror
// Vercel Workflow (src/workflows/sdeMirror.ts) and returns. Fire-and-forget:
// the workflow owns retries and its run/step status shows under
// Observability → Workflows; the heartbeat pair is recorded by the workflow's
// first and last steps. Pass ?force=1 to re-ingest a build that's already
// mirrored (the first manual kick, or repairing a bad ingest).
export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  const force = request.nextUrl.searchParams.get('force') != null
  const { start } = await import('workflow/api')
  const { sdeMirrorWorkflow } = await import('@/workflows/sdeMirror')
  const run = await start(sdeMirrorWorkflow, [{ force }])
  console.log(`[cron/sde-mirror] started workflow run=${run.runId} force=${force}`)

  return NextResponse.json({ ok: true, runId: run.runId })
}
