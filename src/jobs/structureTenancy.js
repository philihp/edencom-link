import { reduce } from 'ramda'

// Who builds where: the structure_tenant fact the two industry-job extracts
// keep (docs/sharing-layer/12-structure-share.md). One row per owner and
// player structure, carrying how many of the owner's jobs there are still
// open — active, paused, or ready and not yet delivered. The sharing layer
// reads it through is_tenant_of(): "does the caller hold an open job at this
// structure" answered without any policy reading the job tables, which is
// what keeps the job-share policy of phase 13 from recursing into the table
// it protects.
//
// This module is the pure half — what a listing proves — so the test suite
// can load it without a Supabase client. The writer, recordStructureTenancy,
// lives in lib.js beside recordCorpJobAccess, the fact it is modelled on.

// A job is open while it can still advance or still sits undelivered in the
// structure. delivered / cancelled / reverted are over (TERMINAL_STATUSES in
// industryJobReconcile.js); nothing else exists in ESI's vocabulary.
export const OPEN_STATUSES = new Set(['active', 'paused', 'ready'])

// Player structure ids start at 100 billion; anything below is an NPC station
// (the same floor src/app/structure/roster.ts and the other jobs use).
const STRUCTURE_ID_FLOOR = 100_000_000_000

// Where a job ran: Upwell structures carry the same id in station_id and
// facility_id; NPC stations carry only station_id. Same fallback as
// roster.ts jobLocationId. Null for a station.
const jobStructureId = (job) => {
  const id = Number(job.station_id ?? job.facility_id)
  return Number.isFinite(id) && id >= STRUCTURE_ID_FLOOR ? id : null
}

// The tenancy a complete job listing proves: open jobs per player structure,
// as a Map of structure id → count. Structures with no open job are absent —
// the writer zeroes those. Tested in test/structureTenancy.test.ts.
export const tenancyFromJobs = (jobs) =>
  reduce(
    (acc, job) => {
      const structureId = jobStructureId(job)
      if (structureId !== null && OPEN_STATUSES.has(job.status)) {
        acc.set(structureId, (acc.get(structureId) ?? 0) + 1)
      }
      return acc
    },
    new Map(),
    jobs
  )
