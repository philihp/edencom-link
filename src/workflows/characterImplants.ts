// Pilot for moving the extract jobs onto Vercel Workflows: the queue consumer
// (src/app/api/queue/jobs/route.ts) starts this workflow for character-implants
// messages instead of running the job inline, validating the
// queue → workflow → step chain before any other job migrates. Each run and its
// step's status/errors/timing show up under the Vercel dashboard's
// Observability → Workflows, and the step executes as its own function
// invocation with its own duration budget — the two things the queue consumer's
// single 60s invocation can't offer.

async function syncImplants(registrationIds?: string[]) {
  'use step'
  // Lazy import, same reason as the consumer's JOBS registry: the job module's
  // top-level supabase/esi setup needs env vars absent at build time.
  const { runCharacterImplants } = await import('@/jobs/characterImplants.js')
  await runCharacterImplants(registrationIds ? { registrationIds } : undefined)
}

// One run per queue message; the step gets Workflows' default bounded retries.
// runCharacterImplants (forEachCharacter in src/jobs/lib.js) still does token
// refresh, per-character heartbeats, and the character_implant upsert unchanged.
export async function characterImplantsWorkflow(registrationIds?: string[]) {
  'use workflow'
  await syncImplants(registrationIds)
}
