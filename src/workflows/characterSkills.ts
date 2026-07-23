// character-skills as a Vercel Workflow, mirroring the character-implants pilot
// (src/workflows/characterImplants.ts): the queue consumer
// (src/app/api/queue/jobs/route.ts) starts this workflow for character-skills
// messages instead of running the job inline. Each run and its step's
// status/errors/timing show up under the Vercel dashboard's
// Observability → Workflows, and the step executes as its own function
// invocation with its own duration budget and Workflows' bounded retries.
//
// Only this standalone path runs as a workflow. On the schedule, skills are
// covered by the combined character-status job (also a workflow), which calls
// syncCharacterSkills inline; this route exists for manual/backfill runs.

async function syncSkills(characterIds?: string[]) {
  'use step'
  // Lazy import, same reason as the consumer's JOBS registry: the job module's
  // top-level supabase/esi setup needs env vars absent at build time.
  const { runCharacterSkills } = await import('@/jobs/characterSkills.js')
  await runCharacterSkills(characterIds ? { characterIds } : undefined)
}

// One run per queue message; the step gets Workflows' default bounded retries.
// runCharacterSkills (forEachCharacter in src/jobs/lib.js) still does token
// refresh, per-character heartbeats, and the character_skill upsert unchanged.
export async function characterSkillsWorkflow(characterIds?: string[]) {
  'use workflow'
  await syncSkills(characterIds)
}
